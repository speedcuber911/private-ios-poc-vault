import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cursor-catalog-"));
const cursorBin = path.join(dir, "cursor-agent");
fs.writeFileSync(cursorBin, "");
process.env.CODEX_DATA_DIR = path.join(dir, "data");
process.env.CODEX_RUN_HOME = path.join(dir, "home");
process.env.CURSOR_BIN = cursorBin;
process.env.KIMI_BIN = path.join(dir, "missing-kimi");
delete process.env.CODEX_MODEL_CATALOG;
delete process.env.BEDROCK_CHAT_MODEL;
delete process.env.AZURE_OPENAI_DEPLOYMENT;

const {
  defaultModelCatalog,
  parseCursorModelList,
  runtimeCursorDescriptor,
  mergeRuntimeCursorModels,
} = await import("../src/catalog.mjs");

test("an installed Cursor CLI advertises Auto plus named models", () => {
  const catalog = defaultModelCatalog();
  const cursor = catalog.filter((entry) => entry.provider === "cursor");
  assert.deepEqual(cursor.map((entry) => entry.taskModel), [
    "auto",
    "cursor-grok-4.6-xhigh-fast",
    "composer-2.5-fast",
    "claude-opus-5-thinking-high",
    "claude-opus-4-8-thinking-high",
    "gpt-5.6-sol-max-fast",
    "gpt-5.5-medium",
    "claude-fable-5-1-thinking-high",
  ]);
  assert.equal(cursor[0].id, "cursor-agent-auto");
  assert.equal(cursor[1].id, "cursor-grok-4.6-xhigh-fast");
  assert.equal(cursor[1].label, "Cursor Agent · Cursor Grok 4.6 Extra High Fast");
  assert.equal(cursor[2].label, "Cursor Agent · Composer 2.5 Fast");
  assert.equal(cursor[3].label, "Cursor Agent · Claude Opus 5 High");
  assert.ok(cursor.every((entry) => entry.modes.includes("task")));
});

test("runtime Cursor descriptors skip hidden or invalid ids", () => {
  assert.equal(runtimeCursorDescriptor({ id: "composer-2.5" }).taskModel, "composer-2.5");
  assert.equal(runtimeCursorDescriptor("gpt-5").taskModel, "gpt-5");
  assert.equal(runtimeCursorDescriptor({ id: "hidden", hidden: true }), null);
  assert.equal(runtimeCursorDescriptor({ id: "not a model" }), null);
});

test("parseCursorModelList accepts JSON, JSONL, and dashed CLI tables", () => {
  const json = parseCursorModelList(JSON.stringify({
    models: [
      { id: "auto", displayName: "Auto" },
      { id: "composer-2.5", name: "Composer 2.5" },
      { id: "composer-2.5" },
    ],
  }));
  assert.deepEqual(json.map((entry) => entry.taskModel), ["auto", "composer-2.5"]);

  const table = parseCursorModelList(`
Available models
composer-2.5 - Composer 2.5
gpt-5 - GPT-5
sonnet-4-thinking - Claude 4 Sonnet (Thinking)
Tip: use --model <id>
`);
  assert.deepEqual(table.map((entry) => entry.taskModel), ["composer-2.5", "gpt-5", "sonnet-4-thinking"]);
  assert.equal(table[2].label, "Cursor Agent · Claude 4 Sonnet (Thinking)");
});

test("live Cursor discovery keeps Auto, fallbacks, and extra CLI models", () => {
  const configured = [
    { id: "codex-cli", provider: "codex", modes: ["task"] },
    { id: "cursor-agent-auto", provider: "cursor", modes: ["task"], taskModel: "auto" },
    { id: "claude-code", provider: "claude", modes: ["task"] },
  ];
  const merged = mergeRuntimeCursorModels(configured, [
    runtimeCursorDescriptor("composer-2.5"),
    runtimeCursorDescriptor("gpt-5"),
  ]);
  assert.deepEqual(
    merged.filter((entry) => entry.provider === "cursor").map((entry) => entry.taskModel),
    ["auto", "composer-2.5", "gpt-5"],
  );
  assert.equal(merged.find((entry) => entry.provider === "claude").id, "claude-code");

  const withFallbacks = mergeRuntimeCursorModels(defaultModelCatalog(), [
    runtimeCursorDescriptor("auto"),
    runtimeCursorDescriptor("future-cursor-model"),
  ]);
  assert.deepEqual(
    withFallbacks.filter((entry) => entry.provider === "cursor").map((entry) => entry.taskModel),
    [
      "auto",
      "cursor-grok-4.6-xhigh-fast",
      "composer-2.5-fast",
      "claude-opus-5-thinking-high",
      "claude-opus-4-8-thinking-high",
      "gpt-5.6-sol-max-fast",
      "gpt-5.5-medium",
      "claude-fable-5-1-thinking-high",
      "future-cursor-model",
    ],
  );
});
