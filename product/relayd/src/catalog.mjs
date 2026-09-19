// relayd catalog.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { allowedThreadProviders, bedrockRegion, cleanDisplayName, cleanOptionalEndpoint, cleanOptionalFilePath, cleanEnvironmentVariableName, cleanOptionalAwsProfile, codexBin, cursorBin, kimiBin, codexHome, runHome, workspaceBrowseRoot } from "./config.mjs";
import { AppServerClient } from "./appserver-client.mjs";

const CURSOR_FALLBACK_MODELS = [
  { id: "auto", label: "Auto" },
  { id: "cursor-grok-4.6-xhigh-fast", label: "Cursor Grok 4.6 Extra High Fast" },
  { id: "composer-2.5-fast", label: "Composer 2.5 Fast" },
  { id: "claude-opus-5-thinking-high", label: "Claude Opus 5 High" },
  { id: "claude-opus-4-8-thinking-high", label: "Claude Opus 4.8 High" },
  { id: "gpt-5.6-sol-max-fast", label: "GPT-5.6 Sol Max Fast" },
  { id: "gpt-5.5-medium", label: "GPT-5.5 Medium" },
  { id: "claude-fable-5-1-thinking-high", label: "Claude Fable 5.1 High" },
];

const modelCatalog = loadModelCatalog();
let runtimeCodexModelsCache = { expiresAt: 0, models: null };
let runtimeCodexModelsRefresh = null;
let runtimeCursorModelsCache = { expiresAt: 0, models: null };
let runtimeCursorModelsRefresh = null;

function loadModelCatalog() {
  const configured = process.env.CODEX_MODEL_CATALOG
    ? JSON.parse(process.env.CODEX_MODEL_CATALOG)
    : defaultModelCatalog();
  if (!Array.isArray(configured)) {
    throw new Error("CODEX_MODEL_CATALOG must be a JSON array");
  }
  return configured.map(cleanModelDescriptor);
}


function defaultModelCatalog() {
  // The harnesses. These are what a node actually runs, and they are the only
  // entries every install should advertise.
  //
  // The label here used to read "Claude Code (Bedrock/SigiQ)" — internal naming
  // carried over verbatim from the codex-api-deploy server this module was
  // extracted from. It leaked to every user of every node, describing a routing
  // detail that is not true of this product and means nothing to them. The
  // provider is the `claude` harness adapter; Bedrock was never involved.
  // Two kinds of entry, on purpose.
  //
  // The first of each provider carries NO taskModel: it runs the harness on
  // whatever model the CLI itself defaults to. That entry is the safety net —
  // it cannot break because of a model name this account is not entitled to,
  // and it is what a node advertised before named models existed here.
  //
  // The rest name a model via `taskModel`, which is what gives the app a model
  // list to choose from after picking a provider. A default install used to
  // advertise one row per harness and nothing else, so there was no model
  // choice at all and — for Codex, which had no effortLevels either — no
  // effort choice. The names mirror the personal install's CODEX_MODEL_CATALOG
  // (ops/init-install-config), because it is the same harness authenticated
  // with the same user's credentials; an install that needs a different set
  // still overrides the whole catalog through CODEX_MODEL_CATALOG.
  //
  // effortLevels is what the app renders as the effort picker
  // (RelayChatViewModel.availableEfforts). Codex had none, so its picker was
  // always empty.
  const catalog = [
    {
      id: "codex-cli",
      label: "Codex CLI",
      provider: "codex",
      modes: ["task"],
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "codex-gpt-5.6-sol",
      label: "Codex · GPT-5.6 Sol",
      provider: "codex",
      modes: ["task"],
      taskModel: "gpt-5.6-sol",
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "codex-gpt-5.6-terra",
      label: "Codex · GPT-5.6 Terra",
      provider: "codex",
      modes: ["task"],
      taskModel: "gpt-5.6-terra",
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "codex-gpt-5.6-luna",
      label: "Codex · GPT-5.6 Luna",
      provider: "codex",
      modes: ["task"],
      taskModel: "gpt-5.6-luna",
      effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    {
      id: "claude-code",
      label: "Claude Code",
      provider: "claude",
      modes: ["task"],
      effortLevels: ["low", "medium", "high"],
    },
    {
      id: "claude-code-sonnet",
      label: "Claude Code · Sonnet",
      provider: "claude",
      modes: ["task"],
      taskModel: "sonnet",
      effortLevels: ["low", "medium", "high"],
    },
    {
      id: "claude-code-opus",
      label: "Claude Code · Opus",
      provider: "claude",
      modes: ["task"],
      taskModel: "opus",
      effortLevels: ["low", "medium", "high"],
    },
    {
      id: "claude-code-haiku",
      label: "Claude Code · Haiku",
      provider: "claude",
      modes: ["task"],
      taskModel: "haiku",
      effortLevels: ["low", "medium", "high"],
    },
  ];
  if (fs.existsSync(cursorBin)) {
    catalog.push(...cursorCatalogEntries(CURSOR_FALLBACK_MODELS));
  }
  if (fs.existsSync(kimiBin)) {
    catalog.push({
      id: "kimi-k3",
      label: "Kimi K3",
      provider: "kimi",
      modes: ["task"],
      taskModel: "kimi-code/k3",
      effortLevels: [],
    });
  }
  // Bedrock is opt-in, exactly like Azure below it. It was unconditional, so
  // every node advertised a "Claude Sonnet (Bedrock)" chat model that could
  // not work: Bedrock needs AWS credentials and a region that a machine set up
  // for direct subscriptions does not have. The old default id was a
  // hard-coded model arn, and `bedrockRegion` cannot serve as the gate because
  // it falls back to "us-east-1" whether or not anyone configured Bedrock.
  // Setting BEDROCK_CHAT_MODEL is the deliberate act that turns it on.
  if (process.env.BEDROCK_CHAT_MODEL) {
    catalog.unshift({
      id: process.env.BEDROCK_CHAT_MODEL,
      label: "Claude Sonnet (Bedrock)",
      provider: "bedrock",
      modes: ["chat"],
      defaultOptions: { temperature: 0.7, maxTokens: 4096 },
      effortLevels: ["low", "medium", "high"],
    });
  }
  if (process.env.AZURE_OPENAI_DEPLOYMENT) {
    catalog.push({
      id: process.env.AZURE_OPENAI_DEPLOYMENT,
      label: `${process.env.AZURE_OPENAI_DEPLOYMENT} (Azure)`,
      provider: "azure",
      modes: ["chat"],
      azureDeployment: process.env.AZURE_OPENAI_DEPLOYMENT,
      defaultOptions: { temperature: 0.7, maxTokens: 4096 },
    });
  }
  return catalog;
}


function cleanModelDescriptor(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error("CODEX_MODEL_CATALOG entries must be objects");
  }
  const id = cleanRequiredModelId(entry.id, "model id");
  const provider = cleanModelProvider(entry.provider);
  const modes = cleanModelModes(entry.modes);
  const descriptor = {
    id,
    label: cleanDisplayName(entry.label || id, "model label", 120),
    provider,
    modes,
  };
  if (entry.azureDeployment !== undefined && entry.azureDeployment !== null && entry.azureDeployment !== "") {
    descriptor.azureDeployment = cleanRequiredModelId(entry.azureDeployment, "Azure deployment");
  }
  // Underlying model id/alias the app sends to createJob for task entries (e.g. "opus",
  // "gpt-5-codex"). Public — the client needs it to select the model.
  if (entry.taskModel !== undefined && entry.taskModel !== null && entry.taskModel !== "") {
    descriptor.taskModel = cleanRequiredModelId(entry.taskModel, "task model");
  }
  if (entry.azureBaseURL !== undefined && entry.azureBaseURL !== null && entry.azureBaseURL !== "") {
    descriptor.azureBaseURL = cleanOptionalEndpoint(entry.azureBaseURL);
    if (!descriptor.azureBaseURL) throw new Error("Azure base URL is invalid");
  }
  if (entry.azureApiKeyFile !== undefined && entry.azureApiKeyFile !== null && entry.azureApiKeyFile !== "") {
    descriptor.azureApiKeyFile = cleanOptionalFilePath(entry.azureApiKeyFile);
    if (!descriptor.azureApiKeyFile) throw new Error("Azure API key file is invalid");
  }
  if (entry.azureApiKeyEnv !== undefined && entry.azureApiKeyEnv !== null && entry.azureApiKeyEnv !== "") {
    descriptor.azureApiKeyEnv = cleanEnvironmentVariableName(entry.azureApiKeyEnv, "Azure API key environment variable");
  }
  if (entry.bedrockRegion !== undefined && entry.bedrockRegion !== null && entry.bedrockRegion !== "") {
    descriptor.bedrockRegion = cleanOptionalAwsProfile(entry.bedrockRegion);
    if (!descriptor.bedrockRegion) throw new Error("Bedrock region is invalid");
  }
  const defaultOptions = cleanChatOptions(entry.defaultOptions || {});
  if (Object.keys(defaultOptions).length > 0) descriptor.defaultOptions = defaultOptions;
  if (Array.isArray(entry.effortLevels)) {
    descriptor.effortLevels = entry.effortLevels
      .map((level) => (typeof level === "string" ? level.trim().toLowerCase() : ""))
      .filter((level) => ["low", "medium", "high", "xhigh", "max", "ultra"].includes(level));
  }
  return descriptor;
}


function cleanModelProvider(value) {
  if (typeof value !== "string") {
    throw new Error("model provider is required");
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedThreadProviders.has(normalized)) {
    throw new Error("model provider must be codex, claude, cursor, kimi, azure, or bedrock");
  }
  return normalized;
}


function cleanModelModes(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("model modes must be a non-empty array");
  }
  const modes = [...new Set(value.map((mode) => (typeof mode === "string" ? mode.trim().toLowerCase() : "")))].filter(
    (mode) => mode === "chat" || mode === "task",
  );
  if (modes.length === 0) {
    throw new Error("model modes must include chat or task");
  }
  return modes;
}


function cleanRequiredModelId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:/-]{1,180}$/.test(value.trim())) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}


function publicModelCatalog() {
  return modelCatalog.map((model) => {
    const {
      azureApiKeyFile,
      azureApiKeyEnv,
      azureBaseURL,
      bedrockRegion: _bedrockRegion,
      ...publicModel
    } = model;
    return publicModel;
  });
}

async function publicRuntimeModelCatalog() {
  const configured = publicModelCatalog();
  // Discovery is independent of whether jobs run through exec or app-server.
  // Share refreshes across phone requests and task validation.
  if (runtimeCodexModelsCache.expiresAt <= Date.now()) {
    if (!runtimeCodexModelsRefresh) {
      runtimeCodexModelsRefresh = refreshRuntimeCodexModels().finally(() => {
        runtimeCodexModelsRefresh = null;
      });
    }
    await runtimeCodexModelsRefresh;
  }
  if (runtimeCursorModelsCache.expiresAt <= Date.now()) {
    if (!runtimeCursorModelsRefresh) {
      runtimeCursorModelsRefresh = refreshRuntimeCursorModels().finally(() => {
        runtimeCursorModelsRefresh = null;
      });
    }
    await runtimeCursorModelsRefresh;
  }
  const withCursor = runtimeCursorModelsCache.models
    ? mergeRuntimeCursorModels(configured, runtimeCursorModelsCache.models)
    : configured;
  return runtimeCodexModelsCache.models
    ? mergeRuntimeCodexModels(withCursor, runtimeCodexModelsCache.models)
    : withCursor;
}

async function refreshRuntimeCodexModels() {
  let client;
  try {
    client = new AppServerClient({
      codexBin,
      cwd: workspaceBrowseRoot,
      env: { ...process.env, HOME: runHome, CODEX_HOME: codexHome },
      requestTimeoutMs: 5000,
    });
    await client.start();
    const models = new Map();
    const cursors = new Set();
    let cursor;
    do {
      const response = await client.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response?.data)) throw new Error("Invalid Codex model list");
      for (const entry of response.data) {
        const model = runtimeCodexDescriptor(entry);
        if (model) models.set(model.taskModel, model);
      }
      cursor = response.nextCursor;
      if (cursor && (typeof cursor !== "string" || cursors.has(cursor) || cursors.size >= 100)) {
        throw new Error("Invalid Codex model list cursor");
      }
      if (cursor) cursors.add(cursor);
    } while (cursor);
    if (!models.size) throw new Error("Empty Codex model list");
    runtimeCodexModelsCache = { models: [...models.values()], expiresAt: Date.now() + 60 * 1000 };
  } catch {
    // Keep the last successful discovery on transient failures, and back off
    // instead of spawning a failing CLI for every request.
    runtimeCodexModelsCache.expiresAt = Date.now() + 30 * 1000;
  } finally {
    client?.stop();
  }
}

function runtimeCodexDescriptor(model) {
  if (!model || model.hidden === true) return null;
  const taskModel = model.model ?? model.id;
  if (typeof taskModel !== "string" || !/^[A-Za-z0-9._:/-]{1,180}$/.test(taskModel)) return null;
  const efforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((entry) => entry?.reasoningEffort).filter((value) => ["low", "medium", "high", "xhigh", "max", "ultra"].includes(value))
    : [];
  return {
    id: `codex-${taskModel}`,
    label: `Codex · ${cleanDisplayName(model.displayName || model.name || taskModel, "model label", 120)}`,
    provider: "codex",
    modes: ["task"],
    taskModel,
    effortLevels: efforts,
  };
}

function mergeRuntimeCodexModels(configured, runtimeModels) {
  const defaultEntry = configured.find((model) => model.provider === "codex" && !model.taskModel);
  const otherProviders = configured.filter((model) => model.provider !== "codex");
  return [...runtimeModels, ...(defaultEntry ? [defaultEntry] : []), ...otherProviders];
}

function cursorCatalogEntries(models) {
  const seen = new Set();
  const entries = [];
  for (const model of models) {
    const taskModel = typeof model?.id === "string" ? model.id.trim() : "";
    if (!taskModel || !isPlausibleCursorModelId(taskModel) || seen.has(taskModel)) continue;
    seen.add(taskModel);
    const label = model.label || cursorModelDisplayName(taskModel);
    entries.push({
      id: taskModel === "auto" ? "cursor-agent-auto" : `cursor-${taskModel.replace(/^cursor-/, "")}`,
      label: `Cursor Agent · ${label}`,
      provider: "cursor",
      modes: ["task"],
      taskModel,
      effortLevels: [],
    });
  }
  return entries;
}

function cursorModelDisplayName(taskModel) {
  const known = CURSOR_FALLBACK_MODELS.find((model) => model.id === taskModel);
  if (known) return known.label;
  if (taskModel === "auto") return "Auto";
  if (/^gpt-/i.test(taskModel)) {
    return taskModel.replace(/^gpt-/i, "GPT-").replace(/-/g, " ");
  }
  return taskModel
    .replace(/^cursor-/, "")
    .replace(/-thinking-high$/, "")
    .replace(/-xhigh-/g, "-extra-high-")
    .replace(/-xhigh$/, "-extra-high")
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => (part === part.toLowerCase() ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function runtimeCursorDescriptor(model) {
  if (!model) return null;
  if (typeof model === "string") {
    return runtimeCursorDescriptor({ id: model });
  }
  if (model.hidden === true) return null;
  const taskModel = model.model ?? model.id ?? model.slug;
  if (typeof taskModel !== "string" || !isPlausibleCursorModelId(taskModel.trim())) return null;
  const id = taskModel.trim();
  const label = model.displayName || model.name || cursorModelDisplayName(id);
  return cursorCatalogEntries([{ id, label }])[0] || null;
}

function isPlausibleCursorModelId(value) {
  if (!/^[A-Za-z0-9._:/-]{1,180}$/.test(value)) return false;
  if (/^(error|errors|warning|info|debug|authentication|required|usage|help|tip|available|models?)$/i.test(value)) {
    return false;
  }
  return value === "auto" || /[./_-]/.test(value);
}

function parseCursorModelList(text) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return [];
  const seen = new Set();
  const models = [];
  const add = (entry) => {
    const descriptor = runtimeCursorDescriptor(entry);
    if (!descriptor || seen.has(descriptor.taskModel)) return;
    seen.add(descriptor.taskModel);
    models.push(descriptor);
  };

  const tryJson = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const parsed = tryJson(cleaned);
  if (parsed) {
    const list = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.models)
        ? parsed.models
        : Array.isArray(parsed.data)
          ? parsed.data
          : [];
    for (const entry of list) add(entry);
    return models;
  }

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*[-*•]\s*/, "").trim();
    if (!line || /^(available|models?|tip:|use --model)/i.test(line)) continue;
    const jsonLine = tryJson(line);
    if (jsonLine) {
      add(jsonLine);
      continue;
    }
    const dashed = line.match(/^([A-Za-z0-9._:/-]{1,180})\s+[-–—]\s+(.+)$/);
    if (dashed) {
      add({ id: dashed[1], displayName: dashed[2].trim() });
      continue;
    }
    const token = line.split(/\s+/)[0];
    if (token && /^[A-Za-z0-9._:/-]{1,180}$/.test(token) && /[A-Za-z]/.test(token)) {
      add({ id: token });
    }
  }
  return models;
}

function cursorDiscoveryEnv() {
  const env = { ...process.env, HOME: runHome, CODEX_HOME: codexHome };
  for (const key of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_AWS_PROFILE",
  ]) {
    delete env[key];
  }
  return env;
}

function execFileText(bin, args, env, timeoutMs = 8000) {
  return new Promise((resolve) => {
    execFile(bin, args, { env, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        text: `${stdout || ""}\n${stderr || ""}`,
      });
    });
  });
}

async function refreshRuntimeCursorModels() {
  if (!fs.existsSync(cursorBin)) {
    runtimeCursorModelsCache = { models: null, expiresAt: Date.now() + 60 * 1000 };
    return;
  }
  try {
    let listed = [];
    for (const args of [["--list-models"], ["models"]]) {
      const result = await execFileText(cursorBin, args, cursorDiscoveryEnv());
      listed = parseCursorModelList(result.stdout);
      if (listed.length) break;
    }
    const models = listed.length ? mergeRuntimeCursorModels(cursorCatalogEntries(CURSOR_FALLBACK_MODELS), listed) : null;
    if (!models?.length) throw new Error("Empty Cursor model list");
    runtimeCursorModelsCache = { models, expiresAt: Date.now() + 60 * 1000 };
  } catch {
    runtimeCursorModelsCache.expiresAt = Date.now() + 30 * 1000;
  }
}

function mergeRuntimeCursorModels(configured, runtimeModels) {
  if (!Array.isArray(runtimeModels) || runtimeModels.length === 0) return configured;
  const others = configured.filter((model) => model.provider !== "cursor");
  const configuredCursor = configured.filter((model) => model.provider === "cursor");
  const byId = new Map();
  for (const entry of [...configuredCursor, ...runtimeModels]) {
    if (!entry?.taskModel) continue;
    byId.set(entry.taskModel, entry);
  }
  const auto = byId.get("auto") || cursorCatalogEntries([{ id: "auto", label: "Auto" }])[0];
  const cursorEntries = [auto];
  const seen = new Set(["auto"]);
  const preferred = [
    ...CURSOR_FALLBACK_MODELS.map((model) => model.id),
    ...configuredCursor.map((model) => model.taskModel),
    ...runtimeModels.map((model) => model.taskModel),
  ];
  for (const id of preferred) {
    if (!id || seen.has(id)) continue;
    const entry = byId.get(id);
    if (!entry) continue;
    seen.add(id);
    cursorEntries.push(entry);
  }
  return [...others, ...cursorEntries];
}


function findCatalogModel({ provider, model, mode }) {
  return modelCatalog.find(
    (entry) => entry.provider === provider && entry.id === model && entry.modes.includes(mode),
  );
}


function validateTaskSelectionFromCatalog(catalog, { provider, model, reasoningEffort }) {
  const taskEntries = catalog.filter(
    (entry) => entry.provider === provider && Array.isArray(entry.modes) && entry.modes.includes("task"),
  );
  if (taskEntries.length === 0) {
    throw Object.assign(new Error(`${provider} is not available for task execution`), { status: 400 });
  }

  const modelEntries = model
    ? taskEntries.filter((entry) => entry.taskModel === model)
    : taskEntries.filter((entry) => !entry.taskModel);
  if (model && modelEntries.length === 0) {
    throw Object.assign(new Error(`model is not available for ${provider}: ${model}`), { status: 400 });
  }

  if (reasoningEffort) {
    // A catalog without an explicit default row still has a provider default at
    // the CLI layer (Claude is the common case). In that case the union of the
    // provider's advertised task rows is the only honest default capability.
    const effortEntries = model ? modelEntries : (modelEntries.length ? modelEntries : taskEntries);
    const supported = effortEntries.some(
      (entry) => Array.isArray(entry.effortLevels) && entry.effortLevels.includes(reasoningEffort),
    );
    if (!supported) {
      const label = model || "the provider default model";
      throw Object.assign(
        new Error(`reasoningEffort ${reasoningEffort} is not supported by ${provider} model ${label}`),
        { status: 400 },
      );
    }
  }

  return { model, reasoningEffort };
}


function validateConfiguredTaskSelection(selection) {
  return validateTaskSelectionFromCatalog(publicModelCatalog(), selection);
}


async function validateRuntimeTaskSelection(selection) {
  return validateTaskSelectionFromCatalog(await publicRuntimeModelCatalog(), selection);
}


function cleanChatOptions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const options = {};
  if (value.temperature !== undefined && value.temperature !== null && value.temperature !== "") {
    const temperature = Number(value.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw Object.assign(new Error("temperature must be between 0 and 2"), { status: 400 });
    }
    options.temperature = temperature;
  }
  const maxTokens = value.maxTokens ?? value.max_tokens;
  if (maxTokens !== undefined && maxTokens !== null && maxTokens !== "") {
    const parsed = Number(maxTokens);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 200000) {
      throw Object.assign(new Error("maxTokens must be a positive integer"), { status: 400 });
    }
    options.maxTokens = parsed;
  }
  return options;
}


export {
  modelCatalog,
  loadModelCatalog,
  defaultModelCatalog,
  cleanModelDescriptor,
  cleanModelProvider,
  cleanModelModes,
  cleanRequiredModelId,
  publicModelCatalog,
  publicRuntimeModelCatalog,
  runtimeCodexDescriptor,
  runtimeCursorDescriptor,
  parseCursorModelList,
  mergeRuntimeCodexModels,
  mergeRuntimeCursorModels,
  cursorCatalogEntries,
  findCatalogModel,
  validateTaskSelectionFromCatalog,
  validateConfiguredTaskSelection,
  validateRuntimeTaskSelection,
  cleanChatOptions,
};
