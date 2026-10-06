import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// config.mjs resolves real paths at import; point it at scratch so importing it
// for one pure function touches nothing on the machine.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "relay-harness-bin-"));
process.env.CODEX_DATA_DIR = path.join(scratch, "data");
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "demo", name: "Demo", path: path.join(scratch, "ws") }]);
process.env.CODEX_WORKSPACE_BROWSE_ROOT = scratch;
const { resolveHarnessBin } = await import("../src/config.mjs");

function makeBin(dir, name, mode) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(file, mode);
  return file;
}

test("an explicit path is honoured even when nothing is there", () => {
  assert.equal(resolveHarnessBin("/nowhere/claude", "claude", "/usr/bin/claude", ""), "/nowhere/claude");
});

test("a name on PATH that cannot be executed is skipped for one that can", () => {
  const first = path.join(scratch, "first");
  const second = path.join(scratch, "second");
  makeBin(first, "claude", 0o644);
  const working = makeBin(second, "claude", 0o755);
  const searchPath = [first, second].join(path.delimiter);

  assert.equal(resolveHarnessBin("", "claude", path.join(scratch, "missing", "claude"), searchPath), working);
});

test("a dangling link and a directory of the same name are skipped", () => {
  const dangling = path.join(scratch, "dangling");
  const directory = path.join(scratch, "directory");
  const good = path.join(scratch, "good");
  fs.mkdirSync(dangling, { recursive: true });
  fs.symlinkSync(path.join(scratch, "gone", "codex"), path.join(dangling, "codex"));
  fs.mkdirSync(path.join(directory, "codex"), { recursive: true });
  const working = makeBin(good, "codex", 0o755);
  const searchPath = [dangling, directory, good].join(path.delimiter);

  assert.equal(resolveHarnessBin("", "codex", path.join(scratch, "missing", "codex"), searchPath), working);
});

test("the conventional location wins when it can be run", () => {
  const conventional = makeBin(path.join(scratch, "conventional"), "claude", 0o755);
  const other = path.join(scratch, "other");
  makeBin(other, "claude", 0o755);

  assert.equal(resolveHarnessBin("", "claude", conventional, other), conventional);
});

test("nothing runnable anywhere falls back to the conventional path so the error names it", () => {
  const conventional = path.join(scratch, "absent", "claude");
  assert.equal(resolveHarnessBin("", "claude", conventional, path.join(scratch, "empty")), conventional);
});
