import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspacesModule = fileURLToPath(new URL("../src/workspaces.mjs", import.meta.url));

test("picker workspace list discovers project folders and skips junk", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-picker-ws-"));
  const komal = path.join(root, "Komal");
  fs.mkdirSync(path.join(komal, "cloud-agents"), { recursive: true });
  fs.mkdirSync(path.join(komal, "extra-project"), { recursive: true });
  fs.mkdirSync(path.join(komal, "node_modules"), { recursive: true });
  const repo = path.join(komal, "private-ios-poc-vault");
  fs.mkdirSync(path.join(repo, "ios"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "rocketizer"), { recursive: true });
  fs.mkdirSync(path.join(root, "Library", "Caches"), { recursive: true });

  const code = `
    import { pickerWorkspaceList, workspaceList } from ${JSON.stringify(workspacesModule)};
    const picker = pickerWorkspaceList();
    const registered = workspaceList();
    console.log(JSON.stringify({
      pickerNames: picker.map((workspace) => workspace.name),
      pickerPaths: picker.map((workspace) => workspace.path),
      registeredNames: registered.map((workspace) => workspace.name),
    }));
  `;

  const output = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: {
      ...process.env,
      CODEX_DATA_DIR: path.join(root, "data"),
      CODEX_WORKSPACE_BROWSE_ROOT: root,
      CODEX_WORKSPACES: JSON.stringify([{ id: "komal", name: "Komal", path: komal }]),
      CODEX_REQUIRE_MTLS: "false",
    },
    encoding: "utf8",
  });
  const { pickerNames, pickerPaths, registeredNames } = JSON.parse(output.trim());

  assert.deepEqual(registeredNames, ["Komal"]);
  assert.ok(pickerNames.includes("Komal"));
  assert.ok(pickerNames.includes("Komal / cloud-agents"));
  assert.ok(pickerNames.includes("Komal / extra-project"));
  assert.ok(pickerNames.includes("Komal / private-ios-poc-vault"));
  assert.ok(pickerNames.includes("rocketizer") || pickerNames.some((name) => name.endsWith("rocketizer")));
  assert.ok(!pickerPaths.some((entry) => entry.includes("node_modules")));
  assert.ok(!pickerPaths.some((entry) => entry.endsWith(`${path.sep}ios`)));
  assert.ok(!pickerPaths.some((entry) => entry.includes(`${path.sep}Library${path.sep}`)));
});
