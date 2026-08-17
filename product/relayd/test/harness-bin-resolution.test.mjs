// Where relayd looks for a harness CLI.
//
// `/usr/bin/codex` and `/usr/bin/claude` were hardcoded defaults, true only
// where npm's global prefix is /usr. The trial image unpacks node under
// /opt/node, so `npm install -g` put them at /opt/node/bin — and every trial
// sandbox answered every prompt with `spawn /usr/bin/codex ENOENT`. Both
// harnesses, every trial machine, since the first one ever provisioned.
//
// config.mjs resolves at import from process.env, so each case runs in its own
// child process with a purpose-built PATH.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const configURL = new URL("../src/config.mjs", import.meta.url);
const CONFIG = fileURLToPath(configURL);

// Reports the resolved paths from a fresh module load under the given env.
//
// config.mjs creates its data directories at import, so every child gets a
// throwaway CODEX_DATA_DIR — otherwise the load dies on
// `EACCES: mkdir '/var/lib/codex-api'` long before resolution is reached.
function resolveUnder(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-data-"));
  try {
    const script =
      `import { codexBin, claudeBin, cursorBin, kimiBin } from ${JSON.stringify(CONFIG)};` +
      `process.stdout.write(JSON.stringify({ codexBin, claudeBin, cursorBin, kimiBin }));`;
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, CODEX_DATA_DIR: dataDir, ...env },
      encoding: "utf8",
    });
    return JSON.parse(out);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function tempBinDir(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-bin-"));
  for (const name of names) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

test("a harness installed outside /usr/bin is found on PATH", (t) => {
  const dir = tempBinDir(["codex", "claude"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolved = resolveUnder({
    PATH: dir,
    CODEX_BIN: "",
    CLAUDE_BIN: "",
  });

  assert.equal(resolved.codexBin, path.join(dir, "codex"));
  assert.equal(resolved.claudeBin, path.join(dir, "claude"));
});

// The exact production shape: node under /opt/node, nothing in /usr/bin.
test("the trial image's /opt/node layout resolves instead of ENOENTing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-optnode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "opt", "node", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ["codex", "claude"]) {
    fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\nexit 0\n");
    fs.chmodSync(path.join(binDir, name), 0o755);
  }

  const resolved = resolveUnder({ PATH: binDir, CODEX_BIN: "", CLAUDE_BIN: "" });

  assert.equal(resolved.codexBin, path.join(binDir, "codex"));
  assert.equal(resolved.claudeBin, path.join(binDir, "claude"));
  assert.ok(!resolved.codexBin.startsWith("/usr/bin"), resolved.codexBin);
});

// An operator who names a path gets an error about THAT path, not a silent
// substitution of whatever happens to be on PATH.
test("an explicit CODEX_BIN wins even when it points at nothing", (t) => {
  const dir = tempBinDir(["codex"]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolved = resolveUnder({
    PATH: dir,
    CODEX_BIN: "/nowhere/special/codex",
    CLAUDE_BIN: "",
  });

  assert.equal(resolved.codexBin, "/nowhere/special/codex");
});

// Nothing anywhere: keep the conventional path so the failure names the place
// an operator would expect, rather than an empty string.
test("with no binary anywhere the conventional path is still reported", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-empty-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const resolved = resolveUnder({ PATH: dir, CODEX_BIN: "", CLAUDE_BIN: "" });

  assert.equal(resolved.codexBin, "/usr/bin/codex");
  assert.equal(resolved.claudeBin, "/usr/bin/claude");
});

// Cursor was never broken — its default is derived from CODEX_RUN_HOME rather
// than guessed at /usr/bin. Pin that, so the fix above cannot regress it.
test("cursor still resolves under CODEX_RUN_HOME", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  const resolved = resolveUnder({ CODEX_RUN_HOME: home, CURSOR_BIN: "" });

  assert.equal(resolved.cursorBin, path.join(home, ".local", "bin", "cursor-agent"));
});

test("kimi resolves under CODEX_RUN_HOME and can be found on PATH", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-kimi-home-"));
  const binDir = tempBinDir(["kimi"]);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const fromHome = resolveUnder({ CODEX_RUN_HOME: home, PATH: "", KIMI_BIN: "" });
  assert.equal(fromHome.kimiBin, path.join(home, ".local", "bin", "kimi"));

  const fromPath = resolveUnder({ CODEX_RUN_HOME: home, PATH: binDir, KIMI_BIN: "" });
  assert.equal(fromPath.kimiBin, path.join(binDir, "kimi"));
});

// A PATH entry that cannot be read must not abort resolution.
test("an unreadable PATH entry is skipped, not fatal", (t) => {
  const good = tempBinDir(["codex"]);
  t.after(() => fs.rmSync(good, { recursive: true, force: true }));

  const resolved = resolveUnder({
    PATH: ["/definitely/not/here", "", good].join(path.delimiter),
    CODEX_BIN: "",
  });

  assert.equal(resolved.codexBin, path.join(good, "codex"));
});
