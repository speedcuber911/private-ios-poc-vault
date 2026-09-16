import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AppServerClient } from "../src/appserver-client.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-model-discovery-"));
process.env.CODEX_DATA_DIR = path.join(dir, "data");
process.env.CODEX_RUN_HOME = path.join(dir, "home");
process.env.CODEX_HOME = path.join(dir, "home", ".codex");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = dir;
process.env.RELAYD_CODEX_TRANSPORT = "exec";
process.env.CODEX_MODEL_CATALOG = JSON.stringify([
  { id: "codex-cli", label: "Codex", provider: "codex", modes: ["task"] },
  { id: "old-sol", label: "Sol", provider: "codex", modes: ["task"], taskModel: "gpt-5.6-sol" },
  { id: "claude-code", label: "Claude", provider: "claude", modes: ["task"] },
]);
const { publicRuntimeModelCatalog, runtimeCodexDescriptor, validateRuntimeTaskSelection } = await import("../src/catalog.mjs");
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const astra = {
  id: "picker-row-astra", model: "gpt-6-astra", displayName: "GPT-6 Astra",
  supportedReasoningEfforts: [{ reasoningEffort: "high" }, { reasoningEffort: "ultra" }],
};

test("uses the executable model slug and excludes hidden or invalid entries", () => {
  assert.equal(runtimeCodexDescriptor(astra).taskModel, "gpt-6-astra");
  assert.deepEqual(runtimeCodexDescriptor(astra).effortLevels, ["high", "ultra"]);
  assert.equal(runtimeCodexDescriptor({ ...astra, hidden: true }), null);
  assert.equal(runtimeCodexDescriptor({ model: "invalid model" }), null);
  assert.equal(runtimeCodexDescriptor({ id: "older-cli-model" }).taskModel, "older-cli-model");
});

test("exec discovery paginates, refreshes, coalesces requests, and survives outages", async (t) => {
  let now = 1_000_000;
  let starts = 0;
  let stops = 0;
  let failure = true;
  let repeatedCursor = false;
  let futureModel = false;
  const requests = [];
  t.mock.method(Date, "now", () => now);
  t.mock.method(AppServerClient.prototype, "start", async () => { starts++; });
  t.mock.method(AppServerClient.prototype, "stop", () => { stops++; });
  t.mock.method(AppServerClient.prototype, "request", async (method, params) => {
    assert.equal(method, "model/list");
    assert.equal(params.includeHidden, false);
    requests.push(params);
    if (failure) throw new Error("offline");
    if (!params.cursor) return { data: [{ id: "gpt-5.6-sol" }], nextCursor: "page-two" };
    assert.equal(params.cursor, "page-two");
    return {
      data: [astra, astra, { id: "hidden-model", hidden: true }, ...(futureModel ? [{ id: "future-model" }] : [])],
      nextCursor: repeatedCursor ? "page-two" : null,
    };
  });

  // Older/offline CLIs still get the configured fallback, with retry backoff.
  assert.ok((await publicRuntimeModelCatalog()).some(m => m.id === "old-sol"));
  await publicRuntimeModelCatalog();
  assert.equal(starts, 1);
  now += 31_000;
  failure = false;
  const [first, second] = await Promise.all([publicRuntimeModelCatalog(), publicRuntimeModelCatalog()]);
  assert.deepEqual(first, second);
  assert.equal(starts, 2);
  assert.deepEqual(first.map(m => m.id), ["codex-gpt-5.6-sol", "codex-gpt-6-astra", "codex-cli", "claude-code"]);
  assert.equal(stops, starts);
  assert.equal(requests.at(-1).cursor, "page-two");
  await validateRuntimeTaskSelection({ provider: "codex", model: "gpt-6-astra", reasoningEffort: "ultra" });
  await assert.rejects(validateRuntimeTaskSelection({ provider: "codex", model: "gpt-6-astra", reasoningEffort: "low" }), /not supported/);

  now += 61_000;
  failure = true;
  assert.deepEqual(await publicRuntimeModelCatalog(), first);
  assert.equal(starts, 3);
  await publicRuntimeModelCatalog();
  assert.equal(starts, 3);

  // A broken subsequent page never replaces a complete last-known list.
  now += 31_000;
  failure = false;
  repeatedCursor = true;
  assert.deepEqual(await publicRuntimeModelCatalog(), first);
  now += 31_000;
  repeatedCursor = false;
  futureModel = true;
  assert.ok((await publicRuntimeModelCatalog()).some(m => m.taskModel === "future-model"));
  assert.equal(stops, starts);
});
