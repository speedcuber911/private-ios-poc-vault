// relay update — reuse the installer already trusted by this CLI release.
//
// Fetching and executing a fresh remote install.sh would move the release
// trust boundary during an update. Instead, every Relay CLI archive carries
// the reviewed installer and its pinned Ed25519 public key. That installer
// reads latest.txt, verifies the exact release archive, installs it beside the
// old version, and atomically switches the managed `current` symlink.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const bundledInstaller = fileURLToPath(new URL("../../dist/install.sh", import.meta.url));

function runInherited(command, args, { env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`update_command_failed: ${command} exited ${code ?? signal ?? "unknown"}`));
    });
  });
}

async function cmdUpdate(args = [], deps = {}) {
  const {
    home = os.homedir(), env = process.env, log = console.log,
    installerPath = bundledInstaller, run = runInherited,
    exists = fs.existsSync,
  } = deps;
  const unknown = args.filter((arg) => arg !== "--cli-only");
  if (unknown.length > 0) throw new Error(`unknown_option: ${unknown[0]}`);
  if (!exists(installerPath)) throw new Error("bundled_relay_installer_missing");

  log("  Updating Relay CLI from the latest signed release...");
  await run("sh", [installerPath], { env });

  if (!args.includes("--cli-only")) {
    const binDir = env.RELAY_BIN_DIR || path.join(home, ".local", "bin");
    const installedRelay = path.join(binDir, "relay");
    if (!exists(installedRelay)) {
      throw new Error(`updated_relay_not_found: expected the managed executable at ${installedRelay}`);
    }
    log("");
    log("  Refreshing Relay-managed agent skills...");
    await run(installedRelay, ["install-skill"], { env });
  }

  log("");
  log("  Relay is up to date.");
}

export { bundledInstaller, cmdUpdate, runInherited };
