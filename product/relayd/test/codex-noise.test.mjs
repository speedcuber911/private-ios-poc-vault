import assert from "node:assert/strict";
import { test } from "node:test";

import { isCodexHarnessNoise, stripCodexHarnessNoise } from "../src/codex-noise.mjs";

test("Codex arg0 janitor stderr is harness noise", () => {
  assert.equal(
    isCodexHarnessNoise("WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)"),
    true,
  );
  assert.equal(
    isCodexHarnessNoise("WARNING: failed to clean up stale temp dirs · os error 13"),
    true,
  );
  assert.equal(
    isCodexHarnessNoise("WARNING: proceeding, even though we could not create PATH aliases: Permission denied"),
    true,
  );
  assert.equal(
    isCodexHarnessNoise("WARNING: Codex sandbox could not access the workspace"),
    false,
  );
  assert.equal(isCodexHarnessNoise("[relay-step] Running git status"), false);
});

test("stripCodexHarnessNoise drops janitor lines and keeps the rest", () => {
  const raw = [
    "WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)\n",
    "I'll check the repository.\n",
    "WARNING: proceeding, even though we could not create PATH aliases: Permission denied\n",
    "WARNING: Codex sandbox could not access the workspace\n",
  ].join("");
  assert.equal(
    stripCodexHarnessNoise(raw),
    "I'll check the repository.\nWARNING: Codex sandbox could not access the workspace\n",
  );
  assert.equal(stripCodexHarnessNoise(""), "");
  assert.equal(stripCodexHarnessNoise("no warning here"), "no warning here");
});
