import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const relaydBin = fileURLToPath(new URL("../bin/relayd", import.meta.url));

test("relayd enroll registers via env config and exits 0", async () => {
  const calls = [];
  const cloud = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sni: `${JSON.parse(body).nodeId}.tun.test` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    // Two independent regressions this loop guards against:
    //  1. nodeId is lowercase hex; a plain shape check only pins that when
    //     the draw contains a letter a-f (~0.0546% of all-digit 16-char
    //     draws can't distinguish a case regression, since digits are
    //     case-invariant) — so retry with a fresh identity dir each attempt
    //     until a letter appears.
    //  2. The two `node-[0-9a-f]{16}` groups below are captured and compared
    //     explicitly: a single non-backreferenced regex would accept stdout
    //     where the printed SNI does not actually derive from the printed
    //     node id.
    let nodeId = null;
    let stdout = null;
    let expectedToken = null;
    for (let attempt = 0; attempt < 8 && !nodeId; attempt++) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-data-"));
      const token = `tok-cli-${attempt}`;
      const result = await execFileAsync(process.execPath, [relaydBin, "enroll"], {
        env: { ...process.env, CODEX_DATA_DIR: dataDir, RELAYD_ENROLL_URL: cloud.url, RELAYD_ENROLL_TOKEN: token },
      });
      const match = /enrolled (node-[0-9a-f]{16}) sni=(node-[0-9a-f]{16})\.tun\.test/.exec(result.stdout);
      assert.ok(match, `stdout did not match the expected shape: ${result.stdout}`);
      assert.equal(match[2], match[1], "the printed SNI must derive from the printed node id, not an independent value");
      if (/[a-f]/.test(match[1])) { nodeId = match[1]; stdout = result.stdout; expectedToken = token; }
    }
    assert.ok(nodeId,
      "could not mint a nodeId containing a hex letter after 8 attempts — the test premise is broken, not the code under test");
    assert.doesNotMatch(nodeId, /^node-[0-9A-F]{16}$/,
      "sanity: this fixture must actually be capable of catching an uppercase regression");
    assert.ok(!stdout.includes(expectedToken), "token must never be printed");
    assert.equal(calls.at(-1).token, expectedToken);
  } finally {
    cloud.server.close();
  }
});

// Enrollment and trial pairing must not share a failure fate. Enrollment
// succeeds exactly once (the cloud burns the token and flips the trial row to
// `ready`, so a retry can only 401 and the account cannot be re-provisioned),
// whereas pairing is a best-effort, retryable step. Running them as one
// all-or-nothing process is what let a single dropped pairing poll brick a
// trial sandbox: the boot aborted before `relayd run`, and every later boot
// re-ran the spent token and exited. These two flags are what let the trial
// bootstrap keep them apart.
test("relayd enroll --no-pair enrolls and never attempts pairing", async () => {
  const paths = [];
  const cloud = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sni: `${JSON.parse(body).nodeId}.tun.test` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    // Same lowercase-hex vacuity as the test above: retry with a fresh
    // identity dir until the nodeId draw contains a letter. `paths` is reset
    // per attempt so the "only one call" assertion below reflects only the
    // successful attempt, not every retry.
    let nodeId = null;
    let stdout = null;
    let expectedToken = null;
    for (let attempt = 0; attempt < 8 && !nodeId; attempt++) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-nopair-"));
      const token = `tok-nopair-${attempt}`;
      paths.length = 0;
      const result = await execFileAsync(process.execPath, [relaydBin, "enroll", "--no-pair"], {
        env: {
          ...process.env,
          CODEX_DATA_DIR: dataDir,
          RELAYD_ENROLL_URL: cloud.url,
          RELAYD_ENROLL_TOKEN: token,
          // Deliberately present: --no-pair must win over them.
          RELAYD_ENROLL_PAIRING_ID: "11111111-1111-4111-8111-111111111111",
          RELAYD_ENROLL_PAIRING_SECRET: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
        },
      });
      const match = /enrolled (node-[0-9a-f]{16})/.exec(result.stdout);
      assert.ok(match, `stdout did not match the expected shape: ${result.stdout}`);
      if (/[a-f]/.test(match[1])) { nodeId = match[1]; stdout = result.stdout; expectedToken = token; }
    }
    assert.ok(nodeId,
      "could not mint a nodeId containing a hex letter after 8 attempts — the test premise is broken, not the code under test");
    assert.doesNotMatch(nodeId, /^node-[0-9A-F]{16}$/,
      "sanity: this fixture must actually be capable of catching an uppercase regression");
    assert.ok(!stdout.includes("trial device paired"), "pairing must not run under --no-pair");
    assert.ok(!stdout.includes(expectedToken), "token must never be printed");
    assert.deepEqual(
      paths.filter((p) => p.includes("/v1/pairing/")),
      [],
      "no pairing rendezvous call may be made under --no-pair",
    );
    assert.equal(paths.length, 1, `only the enroll call is expected, got ${JSON.stringify(paths)}`);
  } finally {
    cloud.server.close();
  }
});

test("relayd enroll --pair-only pairs without re-running the once-only enrollment", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-paironly-"));
  const paths = [];
  const cloud = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      paths.push(`${req.method} ${req.url}`);
      // 500 (not 404) makes the device-blob poll fail immediately instead of
      // waiting out its 120 s deadline — the point under test is which calls
      // are made, not the pairing handshake itself.
      res.writeHead(500);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    await assert.rejects(
      () =>
        execFileAsync(process.execPath, [relaydBin, "enroll", "--pair-only"], {
          env: {
            ...process.env,
            CODEX_DATA_DIR: dataDir,
            // trialpair pulls in pairing.mjs, which makes config materialize
            // the workspace jail; keep it inside the test's own temp dir
            // instead of the default /srv/codex-workspaces.
            CODEX_WORKSPACE_BROWSE_ROOT: path.join(dataDir, "workspaces"),
            CODEX_WORKSPACES: JSON.stringify([
              { id: "scratch", name: "Scratch", path: path.join(dataDir, "workspaces", "scratch") },
            ]),
            RELAYD_ENROLL_URL: cloud.url,
            // No RELAYD_ENROLL_TOKEN at all: --pair-only must not require the
            // single-use token, which by this point is already burned.
            RELAYD_ENROLL_TOKEN: "",
            RELAYD_ENROLL_PAIRING_ID: "11111111-1111-4111-8111-111111111111",
            RELAYD_ENROLL_PAIRING_SECRET: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
          },
        }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /trial_pair_device_blob_500/);
        return true;
      },
    );
    assert.deepEqual(
      paths.filter((p) => p.includes("/v1/trial-nodes/enroll")),
      [],
      "--pair-only must never re-run enrollment; the token is single-use and already spent",
    );
    assert.ok(
      paths.some((p) => p.includes("/v1/pairing/sessions/")),
      `pairing must be attempted, got ${JSON.stringify(paths)}`,
    );
  } finally {
    cloud.server.close();
  }
});

test("relayd enroll rejects --no-pair together with --pair-only", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-bothflags-"));
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [relaydBin, "enroll", "--no-pair", "--pair-only"], {
        env: { ...process.env, CODEX_DATA_DIR: dataDir, RELAYD_ENROLL_URL: "http://127.0.0.1:1", RELAYD_ENROLL_TOKEN: "t" },
      }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /mutually exclusive/);
      return true;
    },
  );
});

test("relayd enroll fails cleanly without env", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-data2-"));
  await assert.rejects(
    () => execFileAsync(process.execPath, [relaydBin, "enroll"], { env: { ...process.env, CODEX_DATA_DIR: dataDir, RELAYD_ENROLL_URL: "", RELAYD_ENROLL_TOKEN: "" } }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /RELAYD_ENROLL_URL/);
      return true;
    },
  );
});

// Cube restores every sandbox from a snapshot of the template's running
// machine, so the boot process is already up with a frozen environment before
// the control plane knows which trial it serves — create-time env vars only
// ever reach processes started afterwards. Enrollment inputs therefore arrive
// as a file written into the running sandbox through envd, and this is the
// path the trial bootstrap actually takes.
test("relayd enroll reads its inputs from RELAYD_ENROLL_CONFIG", async () => {
  const calls = [];
  const cloud = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sni: `${JSON.parse(body).nodeId}.tun.test` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    // Same lowercase-hex vacuity as the tests above: retry with a fresh
    // identity dir (and its own config file) until the nodeId draw contains
    // a letter.
    let nodeId = null;
    let stdout = null;
    for (let attempt = 0; attempt < 8 && !nodeId; attempt++) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-cfg-"));
      const configPath = path.join(dataDir, "enroll.json");
      fs.writeFileSync(
        configPath,
        JSON.stringify({ cloudUrl: cloud.url, token: "tok-from-file" }),
        { mode: 0o600 },
      );
      const result = await execFileAsync(process.execPath, [relaydBin, "enroll", "--no-pair"], {
        env: {
          ...process.env,
          CODEX_DATA_DIR: dataDir,
          RELAYD_ENROLL_CONFIG: configPath,
          // Deliberately absent from the environment: the file is the source.
          RELAYD_ENROLL_URL: "",
          RELAYD_ENROLL_TOKEN: "",
        },
      });
      const match = /enrolled (node-[0-9a-f]{16})/.exec(result.stdout);
      assert.ok(match, `stdout did not match the expected shape: ${result.stdout}`);
      if (/[a-f]/.test(match[1])) { nodeId = match[1]; stdout = result.stdout; }
    }
    assert.ok(nodeId,
      "could not mint a nodeId containing a hex letter after 8 attempts — the test premise is broken, not the code under test");
    assert.doesNotMatch(nodeId, /^node-[0-9A-F]{16}$/,
      "sanity: this fixture must actually be capable of catching an uppercase regression");
    assert.equal(calls.at(-1).token, "tok-from-file");
    assert.ok(!stdout.includes("tok-from-file"), "token must never be printed");
  } finally {
    cloud.server.close();
  }
});

test("relayd enroll fails clearly on an unreadable config, without leaking it", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-badcfg-"));
  const missing = path.join(dataDir, "absent.json");
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [relaydBin, "enroll", "--no-pair"], {
        env: { ...process.env, CODEX_DATA_DIR: dataDir, RELAYD_ENROLL_CONFIG: missing },
      }),
    (error) => {
      assert.match(error.stderr, /cannot read enroll config/);
      assert.match(error.stderr, /ENOENT/);
      return true;
    },
  );

  const malformed = path.join(dataDir, "bad.json");
  fs.writeFileSync(malformed, '{"token": "s3cr3t-should-not-appear"');
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [relaydBin, "enroll", "--no-pair"], {
        env: { ...process.env, CODEX_DATA_DIR: dataDir, RELAYD_ENROLL_CONFIG: malformed },
      }),
    (error) => {
      // The parse failure must name the file, never echo its contents.
      assert.ok(!error.stderr.includes("s3cr3t-should-not-appear"), "config contents must not be printed");
      return true;
    },
  );
});
