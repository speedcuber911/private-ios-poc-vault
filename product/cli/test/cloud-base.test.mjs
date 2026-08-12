// Where the CLI looks for the control plane, and what it says when it cannot
// reach it. Both of these shipped broken: the default was the placeholder
// `https://api.relay.example`, so a fresh install failed on `relay login` with
// nothing but node's bare "fetch failed".
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const { createCloudApi, PRODUCTION_BASE_URL } = await import("../src/cloud.mjs");

// The real contract, not a literal restated twice. The CLI and the phone
// approve the SAME device code, so a CLI pointed at a control plane the app
// does not use cannot be approved at all — the login just polls until it
// expires. Pinning both spellings against each other is what actually catches
// that; pinning the CLI against a copy of its own string catches nothing.
test("the CLI's production control plane is the same host the iOS app falls back to", () => {
  const swift = fs.readFileSync(
    path.join(repoRoot, "ios", "POCVault", "POCVault", "POCVaultApp.swift"),
    "utf8",
  );
  // AppConfiguration declares authBaseURL twice, once per build. The simulator
  // branch points at a relay-cloud on 127.0.0.1 and is SUPPOSED to differ from
  // this constant; the `#else` branch is the one that ships. Comparing against
  // the wrong branch is not a hypothetical — the first version of this test did
  // exactly that and failed against the simulator's loopback URL.
  const simulatorBranch = swift.indexOf("#if targetEnvironment(simulator)");
  assert.notEqual(simulatorBranch, -1, "POCVaultApp.swift no longer has a simulator build branch");
  const deviceBranch = swift.indexOf("\n#else", simulatorBranch);
  const endOfBranch = swift.indexOf("\n#endif", deviceBranch);
  assert.ok(
    deviceBranch !== -1 && endOfBranch > deviceBranch,
    "POCVaultApp.swift no longer has a device build branch in the expected shape",
  );
  const shipped = swift.slice(deviceBranch, endOfBranch);

  const match = shipped.match(/authBaseURL\s*=\s*configuredURL\([^)]*fallback:\s*"([^"]+)"/s);
  assert.ok(match, "the device branch no longer declares an authBaseURL fallback in the expected shape");
  assert.equal(
    PRODUCTION_BASE_URL,
    match[1],
    "product/cli/src/cloud.mjs and ios/POCVault/POCVault/POCVaultApp.swift disagree about the control plane",
  );
});

// The bug this replaced: `https://api.relay.example` is not a real host, so
// every command failed at the transport layer on a fresh install.
test("the production default is a real host, not a placeholder", () => {
  assert.match(PRODUCTION_BASE_URL, /^https:\/\//);
  assert.doesNotMatch(PRODUCTION_BASE_URL, /\.example(\/|$)/);
  assert.doesNotMatch(PRODUCTION_BASE_URL, /localhost|127\.0\.0\.1/);
});

// The override is the whole local-development story, and it is read at module
// load — so it can only be tested from a process that started with the
// variable already set. Asserting it in-process would assert nothing.
test("RELAY_CLOUD_URL overrides the baked-in default", async () => {
  const script =
    'import("./src/cloud.mjs").then((m) => console.log(m.DEFAULT_BASE_URL + "|" + m.PRODUCTION_BASE_URL))';
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    cwd: path.join(repoRoot, "product", "cli"),
    env: { ...process.env, RELAY_CLOUD_URL: "http://127.0.0.1:8790" },
  });
  const [defaultUrl, production] = stdout.trim().split("|");
  assert.equal(defaultUrl, "http://127.0.0.1:8790");
  // The override must not rewrite the constant it overrides.
  assert.equal(production, PRODUCTION_BASE_URL);
});

test("an unreachable control plane names the host instead of saying 'fetch failed'", async () => {
  const transportError = new TypeError("fetch failed");
  const api = createCloudApi({
    baseUrl: "https://relay.invalid",
    fetchImpl: async () => {
      throw transportError;
    },
  });

  const error = await api.startDeviceLogin({ machineName: "x" }).then(
    () => null,
    (err) => err,
  );

  assert.ok(error, "a transport failure must still reject");
  assert.match(error.message, /^cannot_reach_cloud: https:\/\/relay\.invalid did not respond$/);
  // The original stays reachable for anyone debugging, but must not be what
  // the user reads: bin/relay prints error.message and nothing else.
  assert.equal(error.cause, transportError);
  assert.doesNotMatch(error.message, /fetch failed/);
});

// A non-2xx is a reachable control plane answering. Turning that into
// "did not respond" would send users hunting a network fault that is not
// there, so the new catch must wrap ONLY the transport throw.
test("a reachable control plane returning an error status is not reported as unreachable", async () => {
  const api = createCloudApi({
    baseUrl: "https://relay.invalid",
    fetchImpl: async () => ({ status: 503, json: async () => ({ error: "unavailable" }) }),
  });

  const res = await api.startDeviceLogin({ machineName: "x" });
  assert.equal(res.status, 503);
  assert.deepEqual(res.json, { error: "unavailable" });
});
