// relayd chat.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { host, codexBin, runHome, maxBodyBytes, responseOutputBytes, defaultTimeoutMs, allowedChatProviders, claudeAwsProfile, bedrockRegion, bedrockRuntimeEndpoint, azureOpenAiEndpoint, azureOpenAiApiKey, azureOpenAiApiVersion, chatsDir, cleanOptionalSecret } from "./config.mjs";
import { nowIso, initSse, sendSse, isSafeJobId, cleanApiText, readTextFileBounded } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import { workspaceList, resolveWorkspaceById } from "./workspaces.mjs";
import { cleanRequiredModelId, findCatalogModel, cleanChatOptions } from "./catalog.mjs";
import { cleanOptionalSessionId, cleanSessionTimestamp, summaryText, compareIsoDesc } from "./threads.mjs";
import { jobs, removePathInsideRoot, buildJobEnv, appendBounded } from "./jobs.mjs";
import { store } from "./store.mjs";

let cachedBedrockCredentials = null;


async function handleChatRequest(req, res, body, certSubject) {
  const chat = cleanChatRequest(body);
  initSse(res);

  const abortController = new AbortController();
  req.on("close", () => abortController.abort());

  const startedAt = nowIso();
  const replyChunks = [];
  let usage = null;
  sendSse(res, "meta", {
    threadId: chat.threadId,
    model: chat.model,
    provider: chat.provider,
    workspaceId: chat.workspace?.id ?? null,
  });

  try {
    if (chat.provider === "codex") {
      usage = await streamCodexChat(res, chat, abortController.signal, replyChunks);
    } else if (chat.provider === "azure") {
      usage = await streamAzureChat(res, chat, abortController.signal, replyChunks);
    } else if (chat.provider === "bedrock") {
      usage = await streamBedrockChat(res, chat, abortController.signal, replyChunks);
    }
    const finishedAt = nowIso();
    persistChatThread({
      ...chat,
      assistantText: replyChunks.join(""),
      usage,
      certSubject,
      createdAt: startedAt,
      updatedAt: finishedAt,
    });
  } catch (error) {
    if (!abortController.signal.aborted) {
      sendSse(res, "error", { code: "upstream", message: error.message || String(error) });
    }
  } finally {
    res.end();
  }
}


function cleanChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const provider = cleanChatProvider(body.provider);
  const model = cleanRequiredModelId(body.model, "model");
  const catalogEntry = findCatalogModel({ provider, model, mode: "chat" });
  if (!catalogEntry) {
    throw Object.assign(new Error("model is not available for chat with the requested provider"), { status: 400 });
  }
  const threadId = cleanOptionalSessionId(body.threadId) || crypto.randomUUID();
  const existingThread = readChatThread(threadId);
  if (existingThread && existingThread.provider !== provider) {
    throw Object.assign(new Error("chat thread provider does not match requested provider"), { status: 400 });
  }
  const workspace = resolveChatWorkspace(body.workspaceId, existingThread);
  const messages = cleanChatMessages(body.messages);
  const options = {
    ...(catalogEntry.defaultOptions || {}),
    ...cleanChatOptions(body.options || {}),
  };
  return { provider, model, catalogEntry, threadId, workspace, messages, options };
}

// Resolves the optional chat workspaceId through the same registered/dynamic
// registry used by jobs. Continuations inherit the stored workspace when the
// id is omitted; a conflicting id (including one sent for a legacy
// null-workspace chat) is rejected.

function resolveChatWorkspace(value, existingThread) {
  let requestedId = null;
  if (value !== undefined && value !== null && value !== "") {
    if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
      throw Object.assign(new Error("workspaceId is invalid"), { status: 400 });
    }
    requestedId = value;
  }

  const storedId = existingThread ? existingThread.workspaceId ?? null : null;
  if (existingThread && requestedId && requestedId !== storedId) {
    throw Object.assign(new Error("chat thread workspace does not match requested workspaceId"), { status: 400 });
  }

  const effectiveId = requestedId || storedId;
  if (!effectiveId) return null;

  const workspace = resolveWorkspaceById(effectiveId);
  if (workspace) {
    return { id: workspace.id, name: workspace.name, path: workspace.path };
  }
  if (requestedId && !existingThread) {
    throw Object.assign(new Error("workspaceId is not registered"), { status: 400 });
  }
  // The stored workspace no longer resolves (for example a removed dynamic
  // folder). Keep the persisted identity; Codex chat falls back to scratch.
  return { id: effectiveId, name: existingThread?.workspaceName || effectiveId, path: null };
}


function cleanChatProvider(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("chat provider is required"), { status: 400 });
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedChatProviders.has(normalized)) {
    throw Object.assign(new Error("chat provider must be codex, azure, or bedrock"), { status: 400 });
  }
  return normalized;
}


function cleanChatMessages(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw Object.assign(new Error("messages must be a non-empty array"), { status: 400 });
  }
  if (value.length > 80) {
    throw Object.assign(new Error("messages may include at most 80 entries"), { status: 413 });
  }
  return value.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw Object.assign(new Error("each message must be an object"), { status: 400 });
    }
    const role = typeof message.role === "string" ? message.role.trim().toLowerCase() : "";
    if (!["user", "assistant", "system"].includes(role)) {
      throw Object.assign(new Error("message role must be user, assistant, or system"), { status: 400 });
    }
    const content = typeof message.content === "string" ? message.content.trim() : "";
    if (!content) {
      throw Object.assign(new Error("message content is required"), { status: 400 });
    }
    if (Buffer.byteLength(content, "utf8") > maxBodyBytes) {
      throw Object.assign(new Error("message content is too large"), { status: 413 });
    }
    return { role, content };
  });
}


async function streamCodexChat(res, chat, signal, replyChunks) {
  // A workspace-scoped chat runs read-only in the selected folder; unscoped
  // chats (and stored workspaces that no longer resolve) fall back to scratch.
  const workspace =
    (chat.workspace?.path ? chat.workspace : null) || resolveWorkspaceById("scratch") || workspaceList()[0];
  if (!workspace) {
    throw Object.assign(new Error("Codex chat requires a registered workspace"), { status: 503 });
  }

  const model = chat.catalogEntry.taskModel || chat.model;
  const resultPath = path.join(chatsDir, `.codex-chat-${crypto.randomUUID()}.txt`);
  const args = [
    "-a",
    "never",
    "-s",
    "read-only",
    "-m",
    model,
    "-c",
    'model_reasoning_effort="medium"',
    "exec",
    "-C",
    workspace.path,
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--color",
    "never",
    "-o",
    resultPath,
    "-",
  ];

  let stderr = "";
  const child = spawn(codexBin, args, {
    cwd: workspace.path,
    env: buildJobEnv({ provider: "codex" }),
    stdio: ["pipe", "ignore", "pipe"],
  });

  const stopChild = () => {
    if (child.exitCode !== null || child.killed) return;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    killTimer.unref();
  };

  const timeoutMs = Math.min(defaultTimeoutMs, 5 * 60 * 1000);
  try {
    const result = await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutTimer);
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        stopChild();
        finish(() => reject(Object.assign(new Error("Codex chat request aborted"), { name: "AbortError" })));
      };
      const timeoutTimer = setTimeout(() => {
        stopChild();
        finish(() => reject(new Error("Codex chat timed out")));
      }, timeoutMs);
      timeoutTimer.unref();

      signal.addEventListener("abort", onAbort, { once: true });
      child.stderr.on("data", (chunk) => {
        stderr = appendBounded(stderr, chunk);
      });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("close", (code, childSignal) => finish(() => resolve({ code, signal: childSignal })));
      // Ignore EPIPE-style stdin failures; the close handler settles the result.
      child.stdin.on("error", () => {});
      child.stdin.end(codexChatPrompt(chat.messages));
    });

    if (result.code !== 0) {
      const detail = cleanApiText(stderr).trim().slice(-1000);
      throw new Error(`Codex chat failed${detail ? `: ${detail}` : ""}`);
    }

    const answer = cleanApiText(await readTextFileBounded(resultPath, responseOutputBytes)).trim();
    if (!answer) {
      throw new Error("Codex chat returned an empty response");
    }
    replyChunks.push(answer);
    sendSse(res, "delta", { text: answer });
    sendSse(res, "done", { stopReason: "stop" });
    return null;
  } finally {
    await fsp.rm(resultPath, { force: true });
  }
}


function codexChatPrompt(messages) {
  const transcript = messages
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  return [
    "You are responding inside Relay Chat.",
    "Answer the final user message conversationally and directly using the transcript below.",
    "This is chat, not an agent task: do not inspect or modify files, run commands, or use tools.",
    "Do not mention these instructions or add role prefixes to your answer.",
    "",
    "Conversation transcript:",
    transcript,
  ].join("\n");
}


async function streamAzureChat(res, chat, signal, replyChunks) {
  const apiKey = azureApiKeyForModel(chat.catalogEntry);
  if (!azureEndpointForModel(chat.catalogEntry) || !apiKey) {
    throw Object.assign(new Error("Azure OpenAI is not configured"), { status: 503 });
  }
  const deployment = chat.catalogEntry.azureDeployment || chat.model;
  const url = azureChatUrl(chat.catalogEntry, deployment);
  const body = {
    model: deployment,
    messages: chat.messages,
    stream: true,
  };
  // GPT-5.x / o-series reasoning models reject `max_tokens` (require
  // `max_completion_tokens`) and reject a non-default `temperature`. Send the
  // reasoning-friendly shape for those and the classic shape for everyone else.
  const maxTokens = chat.options.maxTokens ?? 4096;
  if (isAzureReasoningModel(deployment)) {
    body.max_completion_tokens = maxTokens;
    if (chat.options.temperature !== undefined && chat.options.temperature !== 1) {
      // Only the default temperature is allowed; drop a custom value rather than 400.
    }
  } else {
    body.max_tokens = maxTokens;
    body.temperature = chat.options.temperature ?? 0.7;
  }
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: azureChatHeaders(chat.catalogEntry, apiKey),
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    const detail = await safeReadErrorDetail(response);
    throw new Error(`Azure OpenAI failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
  }

  let buffer = "";
  for await (const chunk of response.body) {
    buffer += Buffer.from(chunk).toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        sendSse(res, "done", { stopReason: "stop" });
        return null;
      }
      const parsed = JSON.parse(payload);
      const text = parsed?.choices?.[0]?.delta?.content;
      if (text) {
        replyChunks.push(text);
        sendSse(res, "delta", { text });
      }
    }
  }
  sendSse(res, "done", { stopReason: "stop" });
  return null;
}

// GPT-5.x and o-series models on Azure are reasoning models with a stricter request
// contract (max_completion_tokens, default temperature only). Match by deployment id.

function isAzureReasoningModel(deployment) {
  const id = String(deployment || "").toLowerCase();
  return /(^|[^a-z0-9])(gpt-?5|o[134](-|$)|o-series)/.test(id) || id.includes("gpt-5") || /\bo[0-9]\b/.test(id);
}

// Best-effort extraction of an upstream error message so failures are diagnosable
// instead of a bare status code. Never throws.

async function safeReadErrorDetail(response) {
  try {
    const text = await response.text();
    if (!text) return "";
    try {
      const json = JSON.parse(text);
      const message = json?.error?.message || json?.message;
      if (message) return String(message).slice(0, 500);
    } catch {
      // not JSON; fall through to raw text
    }
    return text.replace(/\s+/g, " ").trim().slice(0, 500);
  } catch {
    return "";
  }
}


function azureEndpointForModel(catalogEntry) {
  return catalogEntry.azureBaseURL || azureOpenAiEndpoint;
}


function azureApiKeyForModel(catalogEntry) {
  if (catalogEntry.azureApiKeyFile) {
    try {
      return fs.readFileSync(catalogEntry.azureApiKeyFile, "utf8").trim();
    } catch {
      return null;
    }
  }
  if (catalogEntry.azureApiKeyEnv) {
    return cleanOptionalSecret(process.env[catalogEntry.azureApiKeyEnv]);
  }
  return azureOpenAiApiKey;
}


function azureChatHeaders(catalogEntry, apiKey) {
  if (catalogEntry.azureBaseURL) {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };
  }
  return {
    "content-type": "application/json",
    "api-key": apiKey,
  };
}


function azureChatUrl(catalogEntry, deployment) {
  const endpoint = azureEndpointForModel(catalogEntry).replace(/\/+$/, "");
  if (catalogEntry.azureBaseURL) {
    return `${endpoint}/chat/completions`;
  }
  return `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(azureOpenAiApiVersion)}`;
}


async function streamBedrockChat(res, chat, signal, replyChunks) {
  const credentials = await loadBedrockCredentials();
  const modelPath = `/model/${encodeURIComponent(chat.model)}/converse-stream`;
  const requestRegion = chat.catalogEntry.bedrockRegion || bedrockRegion;
  const endpoint = bedrockRuntimeEndpoint || `https://bedrock-runtime.${requestRegion}.amazonaws.com`;
  const url = new URL(modelPath, endpoint);
  const body = JSON.stringify({
    messages: chat.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role === "assistant" ? "assistant" : "user", content: [{ text: message.content }] })),
    inferenceConfig: {
      maxTokens: chat.options.maxTokens ?? 4096,
      temperature: chat.options.temperature ?? 0.7,
    },
  });
  const headers = signAwsRequest({
    method: "POST",
    url,
    body,
    region: requestRegion,
    service: "bedrock",
    credentials,
    extraHeaders: {
      accept: "application/vnd.amazon.eventstream",
      "content-type": "application/json",
    },
  });
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers,
    body,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Bedrock failed with HTTP ${response.status}`);
  }

  let usage = null;
  for await (const event of decodeAwsEventStream(response.body)) {
    const text = event?.contentBlockDelta?.delta?.text;
    if (text) {
      replyChunks.push(text);
      sendSse(res, "delta", { text });
    }
    if (event?.metadata?.usage) {
      usage = {
        inputTokens: event.metadata.usage.inputTokens ?? null,
        outputTokens: event.metadata.usage.outputTokens ?? null,
      };
      sendSse(res, "usage", usage);
    }
    if (event?.messageStop) {
      sendSse(res, "done", { stopReason: event.messageStop.stopReason || "end_turn" });
    }
  }
  return usage;
}

async function* decodeAwsEventStream(stream) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (buffer.length >= 16) {
      const totalLength = buffer.readUInt32BE(0);
      const headersLength = buffer.readUInt32BE(4);
      if (totalLength < 16 || totalLength > 10 * 1024 * 1024) {
        throw new Error("invalid Bedrock event stream frame");
      }
      if (buffer.length < totalLength) break;
      const payloadStart = 12 + headersLength;
      const payloadEnd = totalLength - 4;
      const payload = buffer.subarray(payloadStart, payloadEnd).toString("utf8").trim();
      buffer = buffer.subarray(totalLength);
      if (!payload) continue;
      yield JSON.parse(payload);
    }
  }
}


async function loadBedrockCredentials() {
  if (claudeAwsProfile !== "sigiq") {
    throw Object.assign(new Error("Bedrock chat is disabled because the SigiQ profile is not configured"), { status: 503 });
  }
  if (cachedBedrockCredentials && (!cachedBedrockCredentials.expiresAt || cachedBedrockCredentials.expiresAt > Date.now() + 60_000)) {
    return cachedBedrockCredentials;
  }
  const profile = claudeAwsProfile;
  const fromFile = readSharedCredentialsProfile(profile);
  if (fromFile) {
    cachedBedrockCredentials = fromFile;
    return fromFile;
  }
  const exported = await exportAwsProfileCredentials(profile);
  cachedBedrockCredentials = exported;
  return exported;
}


function readSharedCredentialsProfile(profile) {
  const credentialsFile = process.env.AWS_SHARED_CREDENTIALS_FILE || path.join(runHome, ".aws", "credentials");
  let contents = "";
  try {
    contents = fs.readFileSync(credentialsFile, "utf8");
  } catch {
    return null;
  }
  let current = null;
  const sections = new Map();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const section = line.match(/^\[([^\]]+)\]$/);
    if (section) {
      current = section[1].trim();
      sections.set(current, {});
      continue;
    }
    if (!current || !line.includes("=")) continue;
    const [key, ...valueParts] = line.split("=");
    sections.get(current)[key.trim()] = valueParts.join("=").trim();
  }
  const entry = sections.get(profile);
  if (!entry?.aws_access_key_id || !entry?.aws_secret_access_key) return null;
  return {
    accessKeyId: entry.aws_access_key_id,
    secretAccessKey: entry.aws_secret_access_key,
    sessionToken: entry.aws_session_token || null,
    expiresAt: null,
  };
}


async function exportAwsProfileCredentials(profile) {
  const env = { ...process.env };
  delete env.AWS_ACCESS_KEY_ID;
  delete env.AWS_SECRET_ACCESS_KEY;
  delete env.AWS_SESSION_TOKEN;
  delete env.AWS_PROFILE;
  delete env.AWS_DEFAULT_PROFILE;
  return new Promise((resolve, reject) => {
    execFile("aws", ["configure", "export-credentials", "--profile", profile, "--format", "json"], { env, timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`failed to export AWS credentials for profile ${profile}: ${stderr || error.message}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
          reject(new Error(`AWS profile ${profile} did not return credentials`));
          return;
        }
        resolve({
          accessKeyId: parsed.AccessKeyId,
          secretAccessKey: parsed.SecretAccessKey,
          sessionToken: parsed.SessionToken || null,
          expiresAt: parsed.Expiration ? Date.parse(parsed.Expiration) : null,
        });
      } catch (parseError) {
        reject(new Error(`failed to parse AWS credentials for profile ${profile}: ${parseError.message}`));
      }
    });
  });
}


function signAwsRequest({ method, url, body, region, service, credentials, extraHeaders }) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = {
    ...extraHeaders,
    host: url.host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (credentials.sessionToken) {
    headers["x-amz-security-token"] = credentials.sessionToken;
  }

  const signedHeaderNames = Object.keys(headers)
    .map((key) => key.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((name) => `${name}:${String(headers[name] ?? headers[Object.keys(headers).find((key) => key.toLowerCase() === name)]).trim().replace(/\s+/g, " ")}\n`)
    .join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method,
    url.pathname,
    url.search ? url.search.slice(1) : "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = awsSigningKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}


function sha256Hex(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}


function awsSigningKey(secretAccessKey, dateStamp, region, service) {
  const kDate = crypto.createHmac("sha256", `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac("sha256", kDate).update(region).digest();
  const kService = crypto.createHmac("sha256", kRegion).update(service).digest();
  return crypto.createHmac("sha256", kService).update("aws4_request").digest();
}


function chatPath(threadId) {
  return path.join(chatsDir, `${threadId}.json`);
}


function persistChatThread(chat) {
  const existing = readChatThread(chat.threadId);
  const createdAt = existing?.createdAt || chat.createdAt || nowIso();
  const incomingMessages = chat.messages.map((message) => ({
    role: message.role,
    text: message.content,
    timestamp: chat.createdAt,
  }));
  const assistantMessage = chat.assistantText
    ? [{ role: "assistant", text: chat.assistantText, timestamp: chat.updatedAt }]
    : [];
  const baseMessages = chatMessagesStartWithExisting(incomingMessages, existing?.messages || [])
    ? incomingMessages
    : [...(existing?.messages || []), ...incomingMessages];
  const thread = {
    id: chat.threadId,
    sessionId: chat.threadId,
    mode: "chat",
    provider: chat.provider,
    model: chat.model,
    workspaceId: chat.workspace?.id ?? null,
    workspaceName: chat.workspace?.name ?? "Chat",
    createdAt,
    updatedAt: chat.updatedAt || nowIso(),
    certSubject: chat.certSubject || existing?.certSubject || null,
    usage: chat.usage || null,
    messages: [...baseMessages, ...assistantMessage],
  };
  // W2-MODULES: persisted through the storage backend; the default JSON
  // backend writes the same chats/<threadId>.json file as before.
  store.saveChatThread(thread);
  appendAudit(
    "chat_completed",
    { id: chat.threadId, status: "succeeded", workspaceId: chat.workspace?.id ?? null, certSubject: chat.certSubject },
    { provider: chat.provider, model: chat.model },
  );
}


function chatMessagesStartWithExisting(incomingMessages, existingMessages) {
  if (!existingMessages.length || incomingMessages.length < existingMessages.length) {
    return false;
  }
  return existingMessages.every((message, index) => {
    const incoming = incomingMessages[index];
    return incoming?.role === message?.role && incoming?.text === message?.text;
  });
}


function readChatThread(threadId) {
  if (!isSafeJobId(threadId)) return null;
  const thread = store.readChatThreadRecord(threadId);
  if (!thread || typeof thread !== "object" || thread.id !== threadId) return null;
  if (!allowedChatProviders.has(thread.provider)) return null;
  return thread;
}


function listChatThreads({ provider = null, workspace = null, limit = 200 } = {}) {
  return store
    .listChatThreadIds()
    .map((threadId) => readChatThread(threadId))
    .filter(Boolean)
    .filter((thread) => !provider || thread.provider === provider)
    // Workspace filters return only chats scoped to that workspace. Legacy
    // null-workspace chats stay global-only.
    .filter((thread) => !workspace || (thread.workspaceId ?? null) === workspace.id)
    .map(chatThreadSummary)
    .sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt))
    .slice(0, limit);
}


function chatThreadSummary(thread) {
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  const lastUser = [...messages].reverse().find((message) => message?.role === "user");
  const lastAssistant = [...messages].reverse().find((message) => message?.role === "assistant");
  return {
    id: thread.id,
    sessionId: thread.sessionId || thread.id,
    mode: "chat",
    provider: thread.provider,
    model: thread.model || null,
    workspaceId: thread.workspaceId ?? null,
    workspaceName: thread.workspaceName || "Chat",
    cwd: null,
    timestamp: thread.createdAt || null,
    updatedAt: thread.updatedAt || thread.createdAt || null,
    jobCount: 0,
    activeJobCount: 0,
    lastJobId: null,
    lastJobStatus: null,
    lastPrompt: summaryText(lastUser?.text),
    lastResult: summaryText(lastAssistant?.text),
    lastError: null,
    hasSessionFile: false,
    isSmokeTest: false,
  };
}


function chatThreadDetailResponse(threadId, { provider = null } = {}) {
  const thread = readChatThread(threadId);
  if (!thread) return null;
  if (provider && thread.provider !== provider) return null;
  return {
    thread: chatThreadSummary(thread),
    messages: (Array.isArray(thread.messages) ? thread.messages : []).map((message) => ({
      role: message?.role === "assistant" ? "assistant" : message?.role === "user" ? "user" : "status",
      timestamp: cleanSessionTimestamp(message?.timestamp) || null,
      text: cleanApiText(message?.text || "").trim(),
    })),
    jobs: [],
  };
}


function deleteChatThread(sessionId, { workspace = null, provider = null, certSubject = null } = {}) {
  const thread = readChatThread(sessionId);
  if (!thread) return null;
  // Workspace-scoped deletion touches only chats bound to that workspace;
  // legacy null-workspace chats are deletable only without a workspace filter.
  if (workspace && (thread.workspaceId ?? null) !== workspace.id) return null;
  if (provider && thread.provider !== provider) return null;
  const deleted = store.deleteChatThread(sessionId);
  if (!deleted) return null;
  appendAudit(
    "thread_deleted",
    { id: sessionId, status: "deleted", workspaceId: thread.workspaceId ?? null, certSubject },
    { provider: thread.provider, deletedJobs: 0, deletedChatThread: true },
  );
  return {
    deleted: true,
    threadId: sessionId,
    workspaceId: thread.workspaceId ?? null,
    deletedJobs: 0,
    deletedSessionFile: false,
    deletedChatThread: true,
  };
}


export {
  cachedBedrockCredentials,
  handleChatRequest,
  cleanChatRequest,
  resolveChatWorkspace,
  cleanChatProvider,
  cleanChatMessages,
  streamCodexChat,
  codexChatPrompt,
  streamAzureChat,
  isAzureReasoningModel,
  safeReadErrorDetail,
  azureEndpointForModel,
  azureApiKeyForModel,
  azureChatHeaders,
  azureChatUrl,
  streamBedrockChat,
  loadBedrockCredentials,
  readSharedCredentialsProfile,
  exportAwsProfileCredentials,
  signAwsRequest,
  sha256Hex,
  awsSigningKey,
  chatPath,
  persistChatThread,
  chatMessagesStartWithExisting,
  readChatThread,
  listChatThreads,
  chatThreadSummary,
  chatThreadDetailResponse,
  deleteChatThread,
};
