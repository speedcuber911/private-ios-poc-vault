// Claude Code's effort levels come from the installed CLI, not from a list
// written in the catalog.
//
// The default catalog used to say low/medium/high on every Claude Code row
// while the CLI on the same machine accepted xhigh and max, so the phone never
// offered them and relayd refused them. A longer static list is not the fix:
// an older CLI would then be offered a level it rejects. The served catalog
// reads the list out of `claude --help`, and job validation reads the same
// catalog, so "offered" and "accepted" cannot drift apart.
//
// Hermetic on purpose: every CLI here is a fake written into a temp dir and
// named through CLAUDE_BIN. Nothing reads the real `claude` on this machine.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { AppServerClient } from "../src/appserver-client.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-claude-efforts-"));
const helpFile = path.join(dir, "claude-help.txt");
const fakeClaude = path.join(dir, "fake-claude");

// One fake CLI whose help is whatever the test last wrote to helpFile; a
// missing file makes `--help` fail, which is the "cannot be read" case.
function writeFakeClaude(file, helpPath) {
  fs.writeFileSync(file, [
    "#!/bin/sh",
    `if [ "$1" = '--help' ]; then cat '${helpPath}' || exit 3; exit 0; fi`,
    "if [ \"$1\" = '--version' ]; then echo 'fake-claude 9.9.9'; exit 0; fi",
    "if [ \"$1\" = 'auth' ]; then echo '{\"loggedIn\":true,\"authMethod\":\"claude.ai\"}'; exit 0; fi",
    "cat >/dev/null",
    "echo 'OK'",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
}
writeFakeClaude(fakeClaude, helpFile);

process.env.CODEX_DATA_DIR = path.join(dir, "data");
process.env.CODEX_RUN_HOME = path.join(dir, "home");
process.env.CODEX_HOME = path.join(dir, "home", ".codex");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = dir;
process.env.RELAYD_CODEX_TRANSPORT = "exec";
process.env.CLAUDE_BIN = fakeClaude;
process.env.CODEX_BIN = path.join(dir, "unconfigured-codex");
process.env.KIMI_BIN = path.join(dir, "unconfigured-kimi");
delete process.env.CODEX_MODEL_CATALOG;
fs.mkdirSync(process.env.CODEX_RUN_HOME, { recursive: true });

const { parseClaudeEffortLevels } = await import("../src/provider-help.mjs");
const {
  publicRuntimeModelCatalog,
  validateRuntimeTaskSelection,
  withInstalledClaudeEfforts,
} = await import("../src/catalog.mjs");

after(() => fs.rmSync(dir, { recursive: true, force: true }));

// Copied from `claude --help` on 2.1.280, wrapping included.
const helpFiveLevels = [
  "  --disallowedTools, --disallowed-tools <tools...>  Comma or space-separated list of tool names to deny (e.g. \"Bash(git *)",
  "                                        Edit\")",
  "  --effort <level>                      Effort level for the current session",
  "                                        (low, medium, high, xhigh, max)",
  "  --environment <environment_id>        Create a new cloud session (see docs)",
  "  --model <model>                       Model for the current session",
  "",
].join("\n");
const helpThreeLevels = [
  "  --effort <level>                      Effort level for the current session (low, medium, high)",
  "  --model <model>                       Model for the current session",
  "",
].join("\n");
const helpWithoutEffort = "  --model <model>  --permission-mode <mode>\n";
// The flag exists but the list is not one we can read.
const helpUnparseable = "  --model <model>  --effort <level>  --permission-mode <mode>\n";

const fallback = ["low", "medium", "high"];
const five = ["low", "medium", "high", "xhigh", "max"];

test("the parser reads the parenthesised list after --effort <level>", () => {
  assert.deepEqual(parseClaudeEffortLevels(helpFiveLevels), five);
  assert.deepEqual(parseClaudeEffortLevels(helpThreeLevels), fallback);
});

test("the parser answers null when there is nothing it can trust", () => {
  assert.equal(parseClaudeEffortLevels(helpWithoutEffort), null);
  assert.equal(parseClaudeEffortLevels(helpUnparseable), null);
  assert.equal(parseClaudeEffortLevels(""), null);
  assert.equal(parseClaudeEffortLevels(undefined), null);
  // A list with no level relayd knows is not a list of levels.
  assert.equal(parseClaudeEffortLevels("  --effort <level>  How hard to think (see docs)\n"), null);
});

test("the parser keeps only relayd's levels, in relayd's order", () => {
  assert.deepEqual(
    parseClaudeEffortLevels("  --effort <level>  Effort (max, turbo, HIGH, low, ultra)\n"),
    ["low", "high", "max", "ultra"],
  );
});

test("the parser does not borrow a list from the next option", () => {
  const help = [
    "  --effort <level>     Effort level for the current session",
    "  --output-format <f>  Output format (low, medium, high)",
    "",
  ].join("\n");
  assert.equal(parseClaudeEffortLevels(help), null);
});

test("the CLI's list lands on every Claude row that offers effort, and nowhere else", () => {
  const catalog = [
    { id: "codex-cli", provider: "codex", modes: ["task"], effortLevels: ["low", "ultra"] },
    { id: "claude-code", provider: "claude", modes: ["task"], effortLevels: fallback },
    { id: "claude-code-haiku", provider: "claude", modes: ["task"], taskModel: "haiku", effortLevels: fallback },
    { id: "claude-quiet", provider: "claude", modes: ["task"], taskModel: "quiet", effortLevels: [] },
    { id: "claude-bare", provider: "claude", modes: ["task"], taskModel: "bare" },
  ];
  const served = withInstalledClaudeEfforts(catalog, () => five);
  assert.deepEqual(served.map((entry) => entry.effortLevels), [["low", "ultra"], five, five, [], undefined]);
  // The configured rows are not edited in place.
  assert.deepEqual(catalog[1].effortLevels, fallback);
  // Nothing readable: the catalog is served exactly as written.
  assert.equal(withInstalledClaudeEfforts(catalog, () => null), catalog);
  assert.equal(withInstalledClaudeEfforts(catalog, () => []), catalog);
});

test("a catalog with no Claude effort row never reads the CLI", () => {
  const catalog = [{ id: "claude-bare", provider: "claude", modes: ["task"] }];
  assert.equal(withInstalledClaudeEfforts(catalog, () => assert.fail("read the CLI for nothing")), catalog);
});

test("the served catalog and job validation follow the installed CLI's help", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  // No Codex here; keep its discovery from spawning anything.
  t.mock.method(AppServerClient.prototype, "start", async () => { throw new Error("no codex in this test"); });
  t.mock.method(AppServerClient.prototype, "stop", () => {});

  const claudeRows = async () => {
    const rows = (await publicRuntimeModelCatalog()).filter((entry) => entry.provider === "claude");
    assert.deepEqual(rows.map((entry) => entry.taskModel), [undefined, "sonnet", "opus", "haiku"]);
    return rows;
  };
  const accepts = (model, reasoningEffort) =>
    validateRuntimeTaskSelection({ provider: "claude", model, reasoningEffort });
  // The help is cached for five minutes; step past it to install "another CLI".
  const install = (help) => {
    if (help === null) fs.rmSync(helpFile, { force: true });
    else fs.writeFileSync(helpFile, help);
    now += 6 * 60 * 1000;
  };

  install(helpFiveLevels);
  for (const row of await claudeRows()) assert.deepEqual(row.effortLevels, five, row.id);
  for (const model of [null, "sonnet", "opus", "haiku"]) {
    assert.equal((await accepts(model, "xhigh")).reasoningEffort, "xhigh");
    assert.equal((await accepts(model, "max")).reasoningEffort, "max");
  }
  // The CLI does not list ultra, so neither does relayd.
  await assert.rejects(() => accepts("opus", "ultra"), /reasoningEffort ultra is not supported by claude model opus/);

  // Cached: a new CLI is not noticed until the window passes.
  fs.writeFileSync(helpFile, helpThreeLevels);
  for (const row of await claudeRows()) assert.deepEqual(row.effortLevels, five, row.id);

  for (const [name, help] of [
    ["three levels", helpThreeLevels],
    ["no --effort", helpWithoutEffort],
    ["unparseable", helpUnparseable],
    ["help that cannot be read", null],
  ]) {
    install(help);
    for (const row of await claudeRows()) assert.deepEqual(row.effortLevels, fallback, `${name}: ${row.id}`);
    await assert.rejects(() => accepts("sonnet", "xhigh"), /reasoningEffort xhigh is not supported/, name);
    await assert.rejects(() => accepts(null, "max"), /reasoningEffort max is not supported/, name);
    assert.equal((await accepts("sonnet", "high")).reasoningEffort, "high", name);
  }
});

// The same thing over HTTP, through the daemon a phone talks to.
async function startDaemon(name, help) {
  const home = path.join(dir, name);
  const workspace = path.join(home, "scratch");
  fs.mkdirSync(workspace, { recursive: true });
  const daemonHelp = path.join(home, "help.txt");
  const daemonClaude = path.join(home, "fake-claude");
  fs.writeFileSync(daemonHelp, help);
  writeFakeClaude(daemonClaude, daemonHelp);
  const port = await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const env = { ...process.env };
  delete env.CODEX_MODEL_CATALOG;
  const child = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
    env: {
      ...env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
      RELAYD_DIRECT_TLS: "false",
      RELAYD_PAIRING_ENABLED: "false",
      RELAYD_CODEX_TRANSPORT: "exec",
      RELAYD_CLAUDE_TRANSPORT: "print",
      CODEX_DATA_DIR: path.join(home, "data"),
      CODEX_RUN_HOME: path.join(home, "run-home"),
      CODEX_HOME: path.join(home, "run-home", ".codex"),
      CODEX_WORKSPACE_BROWSE_ROOT: home,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspace }]),
      CLAUDE_BIN: daemonClaude,
      CODEX_BIN: path.join(home, "unconfigured-codex"),
      KIMI_BIN: path.join(home, "unconfigured-kimi"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  child.stderr.on("data", (chunk) => { output = (output + chunk).slice(-4000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  const stop = async () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      if ((await fetch(`${baseUrl}/healthz`)).ok) break;
    } catch {}
    if (child.exitCode !== null || Date.now() > deadline) {
      await stop();
      throw new Error(`relayd did not start (exit=${child.exitCode}): ${output.trim() || "<no output>"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { baseUrl, stop };
}

async function claudeRowsOver(baseUrl) {
  const { models } = await (await fetch(`${baseUrl}/v1/codex/models`)).json();
  return models.filter((entry) => entry.provider === "claude");
}

function postJob(baseUrl, reasoningEffort) {
  return fetch(`${baseUrl}/v1/codex/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workspaceId: "scratch", provider: "claude", model: "haiku", reasoningEffort, prompt: "Reply with exactly: OK",
    }),
  });
}

test("a daemon whose CLI lists xhigh and max offers them and takes the job", async () => {
  const daemon = await startDaemon("five", helpFiveLevels);
  try {
    const rows = await claudeRowsOver(daemon.baseUrl);
    assert.equal(rows.length, 4);
    for (const row of rows) assert.deepEqual(row.effortLevels, five, row.id);
    for (const level of ["xhigh", "max"]) {
      const response = await postJob(daemon.baseUrl, level);
      const body = await response.json();
      assert.ok(response.status === 200 || response.status === 201 || response.status === 202, JSON.stringify(body));
      assert.equal((body.job || body).reasoningEffort, level);
    }
  } finally {
    await daemon.stop();
  }
});

test("a daemon whose CLI lists three levels offers three and refuses xhigh", async () => {
  const daemon = await startDaemon("three", helpThreeLevels);
  try {
    for (const row of await claudeRowsOver(daemon.baseUrl)) assert.deepEqual(row.effortLevels, fallback, row.id);
    const refused = await postJob(daemon.baseUrl, "xhigh");
    assert.equal(refused.status, 400);
    assert.match((await refused.json()).error, /reasoningEffort xhigh is not supported by claude model haiku/);
    const taken = await postJob(daemon.baseUrl, "high");
    assert.ok(taken.status >= 200 && taken.status < 300);
  } finally {
    await daemon.stop();
  }
});
