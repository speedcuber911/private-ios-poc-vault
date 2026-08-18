import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const trialRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const start = fs.readFileSync(path.join(trialRoot, "start.sh"), "utf8");
const dockerfile = fs.readFileSync(path.join(trialRoot, "Dockerfile"), "utf8");

test("the Cube entrypoint stays root while Relay state and daemon work run as relay", () => {
  assert.doesNotMatch(dockerfile, /^USER\s+relay\s*$/m);
  assert.match(dockerfile, /apt-get install[^\n]*\\[\s\S]*\butil-linux\b/);
  assert.match(start, /^RUN_USER=relay$/m);
  assert.match(start, /^run_as_relay\(\) \{$/m);
  assert.match(
    start,
    /chown "\$\{RUN_USER\}:\$\{RUN_USER\}" \\\n+    "\$\{CODEX_DATA_DIR\}" "\$\{CODEX_WORKSPACE_BROWSE_ROOT\}" "\$\{CODEX_RUN_HOME\}"/,
  );
  assert.match(start, /chmod 750 "\$\{CODEX_WORKSPACE_BROWSE_ROOT\}"/);

  assert.match(
    start,
    /run_as_relay env RELAYD_ENROLL_CONFIG="\$\{ENROLL_CONFIG\}" node "\$\{RELAYD_BIN\}" enroll --no-pair/,
  );
  assert.match(start, /run_as_relay node "\$\{BOOT_DIR\}\/src\/write-runtime-env\.mjs"/);
  assert.match(
    start,
    /run_as_relay env RELAYD_ENROLL_CONFIG="\$\{ENROLL_CONFIG\}" node "\$\{RELAYD_BIN\}" enroll --pair-only/,
  );
  assert.match(
    start,
    /exec runuser --preserve-environment -u "\$\{RUN_USER\}" -- node "\$\{RELAYD_BIN\}" run --mode tunneled/,
  );
});

test("envd-delivered credentials are made relay-readable without widening their mode", () => {
  assert.match(start, /\[ -L "\$\{ENROLL_CONFIG\}" \] \|\| \[ ! -f "\$\{ENROLL_CONFIG\}" \]/);
  assert.match(start, /chown "\$\{RUN_USER\}:\$\{RUN_USER\}" "\$\{ENROLL_CONFIG\}"/);
  assert.match(start, /chmod 600 "\$\{ENROLL_CONFIG\}"/);
  assert.match(start, /chown "\$\{RUN_USER\}:\$\{RUN_USER\}" "\$\{TLS_DIR\}"/);
  assert.match(start, /chmod 700 "\$\{TLS_DIR\}"/);
});
