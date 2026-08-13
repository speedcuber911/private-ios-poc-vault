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

test("an unconfigured node advertises only the harnesses it can actually run", () => {
  const catalog = withEnv(CLEAN, () => defaultModelCatalog());

  assert.deepEqual(
    catalog.map((entry) => entry.id),
    ["codex-cli", "claude-code"],
    "nothing but the two harnesses",
  );
  assert.ok(
    !catalog.some((entry) => entry.provider === "bedrock"),
    "Bedrock must not appear on a node that has no Bedrock credentials",
  );
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
