// The default model catalog — what EVERY node advertises out of the box.
//
// This module was extracted verbatim from the codex-api-deploy server, and it
// brought that deployment's assumptions with it. Two of them reached users:
//
//   1. A "Claude Sonnet (Bedrock)" chat model was in the catalog
//      unconditionally, while the neighbouring Azure entry was correctly gated
//      behind AZURE_OPENAI_DEPLOYMENT. Bedrock needs AWS credentials and a
//      region; a trial sandbox has never had either, so this advertised a model
//      that could not work — on every node, for every user.
//   2. The Claude Code entry was labelled "Claude Code (Bedrock/SigiQ)" —
//      internal routing naming that is not true of this product and means
//      nothing to the person reading the model picker.
//
// bedrockRegion cannot be the gate: it falls back to "us-east-1" whether or not
// anyone configured Bedrock, so it is never absent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-catalog-"));
process.env.CURSOR_BIN = path.join(process.env.CODEX_DATA_DIR, "unconfigured-cursor-agent");

const { defaultModelCatalog } = await import("../src/catalog.mjs");

// defaultModelCatalog() reads process.env at call time, so each case can set
// its own world and restore it.
function withEnv(vars, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CLEAN = { BEDROCK_CHAT_MODEL: undefined, AZURE_OPENAI_DEPLOYMENT: undefined };

test("an unconfigured node advertises only harnesses it can actually run", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());

  assert.deepEqual(
    [...new Set(catalog.map((entry) => entry.provider))].sort(),
    ["claude", "codex"],
    "only the two harnesses the image ships",
  );
  assert.ok(
    !catalog.some((entry) => entry.provider === "bedrock"),
    "Bedrock must not appear on a node that has no Bedrock credentials",
  );
});

// Each provider keeps one entry with NO taskModel. It runs whatever the CLI
// defaults to, so it cannot break because of a model name this account is not
// entitled to — the fallback that stays working when a named row does not.
test("each provider keeps a no-model default entry", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());

  for (const provider of ["codex", "claude"]) {
    const bare = catalog.filter((e) => e.provider === provider && e.taskModel === undefined);
    assert.equal(bare.length, 1, `${provider} must have exactly one harness-default entry`);
  }
});

// The point of the change: picking a provider must then offer models. A
// default install used to advertise one row per harness and nothing else, so
// there was no model choice at all.
test("each provider offers named models to choose from", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());

  for (const provider of ["codex", "claude"]) {
    const named = catalog.filter((e) => e.provider === provider && e.taskModel);
    assert.ok(named.length >= 2, `${provider} offers no model choice: ${named.length} named entries`);
    for (const entry of named) {
      assert.ok(entry.taskModel.length > 0, `${entry.id} has an empty taskModel`);
    }
  }
});

// effortLevels is exactly what the app renders as the effort picker
// (RelayChatViewModel.availableEfforts). Codex had none, so selecting Codex
// produced an empty effort picker on every node.
test("every entry exposes effort levels, so the picker is never empty", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());

  for (const entry of catalog) {
    assert.ok(
      Array.isArray(entry.effortLevels) && entry.effortLevels.length > 0,
      `${entry.id} exposes no effort levels`,
    );
    for (const level of entry.effortLevels) {
      assert.ok(
        ["low", "medium", "high", "xhigh"].includes(level),
        `${entry.id} declares an effort level the server will drop: ${level}`,
      );
    }
  }
});

// Ids reach the app as selection keys and the app assumes they are unique.
test("catalog ids are unique", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());
  const ids = catalog.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(", ")}`);
});

// The specific string the user saw. Worth pinning by exact value: a label is
// the whole of what this entry communicates.
test("Claude Code is labelled Claude Code, with no internal routing names", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());
  const claude = catalog.find((entry) => entry.id === "claude-code");

  assert.equal(claude.label, "Claude Code");
  for (const entry of catalog) {
    assert.doesNotMatch(entry.label, /bedrock/i, `"${entry.label}" leaks internal naming`);
    assert.doesNotMatch(entry.label, /sigiq/i, `"${entry.label}" leaks internal naming`);
  }
});

// Gating it off must not delete the capability — chat.mjs still supports the
// provider, and an operator who configures it should get it back.
test("setting BEDROCK_CHAT_MODEL opts Bedrock back in, using that model id", () => {
  const catalog = withEnv(
    { ...CLEAN, BEDROCK_CHAT_MODEL: "anthropic.claude-3-5-sonnet-20241022-v2:0" },
    () => defaultModelCatalog(),
  );

  const bedrock = catalog.find((entry) => entry.provider === "bedrock");
  assert.ok(bedrock, "an explicitly configured Bedrock model must appear");
  assert.equal(bedrock.id, "anthropic.claude-3-5-sonnet-20241022-v2:0",
    "the id comes from the operator's value, not a hard-coded default");
  assert.equal(bedrock.modes[0], "chat");
  // The harnesses are still there alongside it.
  assert.ok(catalog.some((entry) => entry.id === "codex-cli"));
  assert.ok(catalog.some((entry) => entry.id === "claude-code"));
});

// Azure was already gated; the change must not have disturbed it.
test("Azure remains opt-in and independent of Bedrock", () => {
  const withAzure = withEnv(
    { ...CLEAN, AZURE_OPENAI_DEPLOYMENT: "my-deployment" },
    () => defaultModelCatalog(),
  );
  assert.ok(withAzure.some((entry) => entry.provider === "azure"));
  assert.ok(!withAzure.some((entry) => entry.provider === "bedrock"),
    "configuring Azure must not drag Bedrock in with it");

  const neither = withEnv(CLEAN, () => defaultModelCatalog());
  assert.ok(!neither.some((entry) => entry.provider === "azure"));
});
