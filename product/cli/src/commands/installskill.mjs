// relay install-skill — make "handoff to Relay" a portable agent intent.
//
// The workflow itself is one Agent Skills-compatible SKILL.md. This command
// copies that canonical directory into each supported agent's native user
// scope. Copies are deliberate: Relay releases live in versioned directories,
// so a symlink back into the current package would break on upgrade or
// uninstall. Existing user-authored skills are never overwritten without
// --force.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAME = "relay-handoff";
const MANAGED_MARKER = ".relay-managed.json";
const bundledSkill = fileURLToPath(new URL(`../../plugins/relay-handoff/skills/${SKILL_NAME}`, import.meta.url));

function skillTargets({ home = os.homedir(), env = process.env } = {}) {
  return [
    { agent: "Codex", root: env.CODEX_HOME || path.join(home, ".codex") },
    { agent: "Claude Code", root: env.CLAUDE_CONFIG_DIR || path.join(home, ".claude") },
    { agent: "Cursor", root: path.join(home, ".cursor") },
    { agent: "Kimi Code", root: env.KIMI_CODE_HOME || path.join(home, ".kimi-code") },
  ].map(({ agent, root }) => ({ agent, path: path.join(root, "skills", SKILL_NAME) }));
}

function filesBelow(root) {
  const files = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name !== MANAGED_MARKER) files.push(path.relative(root, absolute));
    }
  }
  visit(root);
  return files;
}

function treeDigest(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return null;
  const hash = crypto.createHash("sha256");
  for (const relative of filesBelow(root)) {
    hash.update(relative);
    hash.update(Buffer.from([0]));
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update(Buffer.from([0]));
  }
  return hash.digest("hex");
}

function readManagedMarker(destination) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(destination, MANAGED_MARKER), "utf8"));
    if (marker?.v !== 1 || marker?.manager !== "relay-cli" || marker?.skill !== SKILL_NAME) return null;
    if (!/^[a-f0-9]{64}$/.test(marker?.sourceDigest || "")) return null;
    return marker;
  } catch {
    return null;
  }
}

function writeManagedMarker(destination, sourceDigest) {
  const markerPath = path.join(destination, MANAGED_MARKER);
  const temporary = `${markerPath}.new-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify({
    v: 1,
    manager: "relay-cli",
    skill: SKILL_NAME,
    sourceDigest,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, markerPath);
}

function installationState(sourceDigest, destination) {
  if (!fs.existsSync(destination)) return "absent";
  const destinationDigest = treeDigest(destination);
  if (destinationDigest === sourceDigest) return "current";
  const marker = readManagedMarker(destination);
  if (marker && marker.sourceDigest === destinationDigest) return "managed-update";
  return "conflict";
}

function installOne(source, destination, { force = false } = {}) {
  const sourceDigest = treeDigest(source);
  if (!sourceDigest) throw new Error("bundled_relay_handoff_skill_missing");

  const priorState = installationState(sourceDigest, destination);
  if (priorState === "current") {
    writeManagedMarker(destination, sourceDigest);
    return "current";
  }
  if (priorState === "conflict" && !force) {
    throw new Error(`skill_conflict: ${destination} was modified or is not Relay-managed; re-run with --force to replace it`);
  }

  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staged = fs.mkdtempSync(path.join(parent, `.${SKILL_NAME}-`));
  const backup = `${destination}.relay-backup-${process.pid}`;
  try {
    fs.cpSync(source, staged, { recursive: true, force: false });
    writeManagedMarker(staged, sourceDigest);
    if (fs.existsSync(destination)) fs.renameSync(destination, backup);
    fs.renameSync(staged, destination);
    fs.rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    fs.rmSync(staged, { recursive: true, force: true });
    if (!fs.existsSync(destination) && fs.existsSync(backup)) fs.renameSync(backup, destination);
    throw error;
  }
  return priorState === "absent" ? "installed" : "updated";
}

function cmdInstallSkill(args = [], deps = {}) {
  const {
    home = os.homedir(), env = process.env, log = console.log,
    source = bundledSkill,
  } = deps;
  const unknown = args.filter((arg) => arg !== "--force");
  if (unknown.length > 0) throw new Error(`unknown_option: ${unknown[0]}`);
  const force = args.includes("--force");
  const results = [];
  const targets = skillTargets({ home, env });

  // Refuse the entire operation before writing any provider when one native
  // directory contains a different skill. A conflict in Claude must not leave
  // Codex updated and the other agents stale.
  const sourceDigest = treeDigest(source);
  if (!sourceDigest) throw new Error("bundled_relay_handoff_skill_missing");
  if (!force) {
    const conflict = targets.find((target) => installationState(sourceDigest, target.path) === "conflict");
    if (conflict) {
      throw new Error(`skill_conflict: ${conflict.path} was modified or is not Relay-managed; re-run with --force to replace it`);
    }
  }

  for (const target of targets) {
    const state = installOne(source, target.path, { force });
    results.push({ ...target, state });
    log(`  ${target.agent.padEnd(11)} ${state === "current" ? "already current" : state}`);
  }
  log("");
  log("  Start a new agent session, then say: handoff to Relay");
  return results;
}

export { cmdInstallSkill, installOne, installationState, readManagedMarker, skillTargets, treeDigest };
