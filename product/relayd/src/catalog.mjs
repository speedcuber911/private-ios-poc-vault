// relayd catalog.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { allowedThreadProviders, bedrockRegion, cleanDisplayName, cleanOptionalEndpoint, cleanOptionalFilePath, cleanEnvironmentVariableName, cleanOptionalAwsProfile } from "./config.mjs";

const modelCatalog = loadModelCatalog();

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
      effortLevels: ["low", "medium", "high", "xhigh"],
    },
    {
      id: "codex-gpt-5.6-sol",
      label: "Codex · GPT-5.6 Sol",
      provider: "codex",
      modes: ["task"],
      taskModel: "gpt-5.6-sol",
      effortLevels: ["low", "medium", "high", "xhigh"],
    },
    {
      id: "codex-gpt-5.6-terra",
      label: "Codex · GPT-5.6 Terra",
      provider: "codex",
      modes: ["task"],
      taskModel: "gpt-5.6-terra",
      effortLevels: ["low", "medium", "high", "xhigh"],
    },
    {
      id: "codex-gpt-5.6-luna",
      label: "Codex · GPT-5.6 Luna",
      provider: "codex",
      modes: ["task"],
      taskModel: "gpt-5.6-luna",
      effortLevels: ["low", "medium", "high", "xhigh"],
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
  // Bedrock is opt-in, exactly like Azure below it. It was unconditional, so
  // every node — including every trial sandbox — advertised a "Claude Sonnet
  // (Bedrock)" chat model that could not work: Bedrock needs AWS credentials
  // and a region that a trial sandbox has never had. The old default id was a
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
      .filter((level) => ["low", "medium", "high", "xhigh"].includes(level));
  }
  return descriptor;
}


function cleanModelProvider(value) {
  if (typeof value !== "string") {
    throw new Error("model provider is required");
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedThreadProviders.has(normalized)) {
    throw new Error("model provider must be codex, claude, cursor, azure, or bedrock");
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


function findCatalogModel({ provider, model, mode }) {
  return modelCatalog.find(
    (entry) => entry.provider === provider && entry.id === model && entry.modes.includes(mode),
  );
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
  findCatalogModel,
  cleanChatOptions,
};
