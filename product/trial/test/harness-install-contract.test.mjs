import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const trialRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the trial image installs and advertises every supported harness binary", () => {
  const dockerfile = fs.readFileSync(path.join(trialRoot, "Dockerfile"), "utf8");
  const start = fs.readFileSync(path.join(trialRoot, "start.sh"), "utf8");

  assert.match(dockerfile, /npm install -g[^\n]*@openai\/codex/);
  assert.match(dockerfile, /npm install -g[^\n]*@anthropic-ai\/claude-code/);
  assert.match(dockerfile, /npm install -g[^\n]*@moonshot-ai\/kimi-code/);
  assert.match(start, /export CODEX_BIN=/);
  assert.match(start, /export CLAUDE_BIN=/);
  assert.match(start, /export KIMI_BIN=/);
});
