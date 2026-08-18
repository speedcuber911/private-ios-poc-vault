import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  cmdInstallSkill, installOne, readManagedMarker, skillTargets, treeDigest,
} from "../src/commands/installskill.mjs";

const source = fileURLToPath(new URL("../plugins/relay-handoff/skills/relay-handoff", import.meta.url));

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-install-skill-"));
}

test("installs one canonical handoff skill for every supported local agent", () => {
  const home = tempHome();
  const lines = [];
  const results = cmdInstallSkill([], { home, env: {}, source, log: (line) => lines.push(line) });

  assert.deepEqual(results.map(({ agent, state }) => ({ agent, state })), [
    { agent: "Codex", state: "installed" },
    { agent: "Claude Code", state: "installed" },
    { agent: "Cursor", state: "installed" },
    { agent: "Kimi Code", state: "installed" },
  ]);
  for (const target of skillTargets({ home, env: {} })) {
    assert.equal(treeDigest(target.path), treeDigest(source));
    assert.equal(readManagedMarker(target.path)?.sourceDigest, treeDigest(source));
  }
  assert.match(lines.join("\n"), /Start a new agent session/);
});

test("is idempotent when every installed copy is current", () => {
  const home = tempHome();
  cmdInstallSkill([], { home, env: {}, source, log: () => {} });
  const results = cmdInstallSkill([], { home, env: {}, source, log: () => {} });
  assert.ok(results.every(({ state }) => state === "current"));
});

test("preflights conflicts before changing any provider and force replaces them", () => {
  const home = tempHome();
  const targets = skillTargets({ home, env: {} });
  fs.mkdirSync(targets[1].path, { recursive: true });
  fs.writeFileSync(path.join(targets[1].path, "SKILL.md"), "user-owned\n");

  assert.throws(
    () => cmdInstallSkill([], { home, env: {}, source, log: () => {} }),
    /skill_conflict/,
  );
  assert.equal(fs.existsSync(targets[0].path), false, "Codex must remain untouched after a Claude conflict");
  assert.equal(fs.readFileSync(path.join(targets[1].path, "SKILL.md"), "utf8"), "user-owned\n");

  const results = cmdInstallSkill(["--force"], { home, env: {}, source, log: () => {} });
  assert.deepEqual(results.map(({ state }) => state), ["installed", "updated", "installed", "installed"]);
  assert.equal(treeDigest(targets[1].path), treeDigest(source));
});

test("updates unchanged Relay-managed copies and preserves user edits", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-managed-skill-"));
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  const destination = path.join(root, "installed");
  fs.cpSync(source, first, { recursive: true });
  fs.cpSync(source, second, { recursive: true });
  fs.appendFileSync(path.join(second, "SKILL.md"), "\nManaged update fixture.\n");

  assert.equal(installOne(first, destination), "installed");
  assert.equal(installOne(second, destination), "updated");
  assert.equal(treeDigest(destination), treeDigest(second));
  assert.equal(readManagedMarker(destination)?.sourceDigest, treeDigest(second));

  fs.appendFileSync(path.join(destination, "SKILL.md"), "\nUser customization.\n");
  assert.throws(() => installOne(first, destination), /skill_conflict/);
  assert.match(fs.readFileSync(path.join(destination, "SKILL.md"), "utf8"), /User customization/);
});

test("adopts an unmarked legacy copy only when its content is exact", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-legacy-skill-"));
  const destination = path.join(root, "installed");
  fs.cpSync(source, destination, { recursive: true });
  assert.equal(readManagedMarker(destination), null);
  assert.equal(installOne(source, destination), "current");
  assert.equal(readManagedMarker(destination)?.sourceDigest, treeDigest(source));
});

test("honors provider-specific home overrides", () => {
  const home = tempHome();
  const env = {
    CODEX_HOME: path.join(home, "codex-home"),
    CLAUDE_CONFIG_DIR: path.join(home, "claude-home"),
    KIMI_CODE_HOME: path.join(home, "kimi-home"),
  };
  const targets = skillTargets({ home, env });
  assert.equal(targets[0].path, path.join(env.CODEX_HOME, "skills", "relay-handoff"));
  assert.equal(targets[1].path, path.join(env.CLAUDE_CONFIG_DIR, "skills", "relay-handoff"));
  assert.equal(targets[3].path, path.join(env.KIMI_CODE_HOME, "skills", "relay-handoff"));
});
