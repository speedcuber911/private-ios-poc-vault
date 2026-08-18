import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { cmdUpdate } from "../src/commands/update.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-update-"));
  const home = path.join(root, "home");
  const binDir = path.join(root, "bin");
  const installerPath = path.join(root, "install.sh");
  const relayPath = path.join(binDir, "relay");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(installerPath, "#!/bin/sh\n");
  fs.writeFileSync(relayPath, "#!/bin/sh\n");
  return { root, home, binDir, installerPath, relayPath };
}

test("updates with the bundled installer then refreshes skills through the new CLI", async () => {
  const { home, binDir, installerPath, relayPath } = fixture();
  const calls = [];
  const env = { RELAY_BIN_DIR: binDir, TOKEN: "preserved" };

  await cmdUpdate([], {
    home, env, installerPath, log: () => {},
    run: async (command, args, options) => calls.push({ command, args, env: options.env }),
  });

  assert.deepEqual(calls, [
    { command: "sh", args: [installerPath], env },
    { command: relayPath, args: ["install-skill"], env },
  ]);
});

test("--cli-only skips skill refresh", async () => {
  const { home, binDir, installerPath } = fixture();
  const calls = [];
  await cmdUpdate(["--cli-only"], {
    home, env: { RELAY_BIN_DIR: binDir }, installerPath, log: () => {},
    run: async (command, args) => calls.push({ command, args }),
  });
  assert.deepEqual(calls, [{ command: "sh", args: [installerPath] }]);
});

test("refuses unknown options and a missing bundled installer", async () => {
  const { home, installerPath } = fixture();
  await assert.rejects(
    () => cmdUpdate(["--force"], { home, installerPath, log: () => {} }),
    /unknown_option/,
  );
  await assert.rejects(
    () => cmdUpdate([], { home, installerPath: `${installerPath}.missing`, log: () => {} }),
    /bundled_relay_installer_missing/,
  );
});
