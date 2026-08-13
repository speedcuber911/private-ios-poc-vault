// relayd must create the harness home directories it names.
//
// buildJobEnv sets HOME=runHome and CODEX_HOME=codexHome on every child, and
// config.mjs created its own data directories but not those. Codex refuses to
// run when CODEX_HOME is absent:
//
//   Error finding codex home: CODEX_HOME points to "/home/relay/.codex",
//   but that path does not exist
//
// It looked fine for a long time only because `relay sync-auth` creates the
// directory as a side effect of writing auth.json — so a synced machine worked
// and a freshly provisioned one failed every single prompt. Reported from a
// trial machine 2026-08-13, immediately after the /usr/bin/codex fix let codex
// get far enough to complain about something else.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG = fileURLToPath(new URL("../src/config.mjs", import.meta.url));

// Loads config.mjs in a child so the import-time side effects run against a
// throwaway filesystem.
function loadConfigUnder(env) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-hh-data-"));
  const script =
    `import { runHome, codexHome } from ${JSON.stringify(CONFIG)};` +
    `process.stdout.write(JSON.stringify({ runHome, codexHome }));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CODEX_DATA_DIR: dataDir, ...env },
    encoding: "utf8",
  });
  return { ...JSON.parse(out), cleanup: () => fs.rmSync(dataDir, { recursive: true, force: true }) };
}

test("CODEX_HOME is created when it does not exist", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-home-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runHome = path.join(root, "relay");
  const codexHome = path.join(runHome, ".codex");

  assert.equal(fs.existsSync(codexHome), false, "precondition: absent before load");

  const cfg = loadConfigUnder({ CODEX_RUN_HOME: runHome, CODEX_HOME: "" });
  t.after(cfg.cleanup);

  assert.equal(cfg.codexHome, codexHome);
  assert.ok(fs.existsSync(codexHome), "codex refuses to start without this directory");
  assert.ok(fs.existsSync(runHome), "HOME is handed to the child too");
});

test("an explicitly set CODEX_HOME is created as well", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-home2-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const explicit = path.join(root, "nested", "codex-home");

  const cfg = loadConfigUnder({ CODEX_RUN_HOME: root, CODEX_HOME: explicit });
  t.after(cfg.cleanup);

  assert.equal(cfg.codexHome, explicit);
  assert.ok(fs.existsSync(explicit));
});

// An existing home must keep its contents — this runs on every boot, including
// on machines that already hold synced credentials.
test("an existing CODEX_HOME keeps whatever is already in it", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-home3-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runHome = path.join(root, "relay");
  const codexHome = path.join(runHome, ".codex");
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), '{"token":"kept"}');

  const cfg = loadConfigUnder({ CODEX_RUN_HOME: runHome, CODEX_HOME: "" });
  t.after(cfg.cleanup);

  assert.equal(
    fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"),
    '{"token":"kept"}',
    "a boot must never clobber synced credentials",
  );
});

// A BYO operator can point CODEX_HOME somewhere this process cannot create.
// That must not stop relayd booting — the harness reports it far more clearly
// than a crashed daemon would.
test("an uncreatable CODEX_HOME does not stop relayd from loading config", (t) => {
  const cfg = loadConfigUnder({
    CODEX_RUN_HOME: os.tmpdir(),
    CODEX_HOME: "/proc/definitely-not-creatable/codex",
  });
  t.after(cfg.cleanup);

  assert.equal(cfg.codexHome, "/proc/definitely-not-creatable/codex");
});
