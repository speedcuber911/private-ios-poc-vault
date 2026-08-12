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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-data-"));
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
    const { stdout } = await execFileAsync(process.execPath, [relaydBin, "enroll"], {
      env: {
        ...process.env,
        CODEX_DATA_DIR: dataDir,
        RELAYD_ENROLL_URL: cloud.url,
        RELAYD_ENROLL_TOKEN: "tok-cli",
      },
    });
    assert.match(stdout, /enrolled node-[0-9a-f]{16} sni=node-[0-9a-f]{16}\.tun\.test/);
    assert.ok(!stdout.includes("tok-cli"), "token must never be printed");
    assert.equal(calls[0].token, "tok-cli");
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-nopair-"));
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
    const { stdout } = await execFileAsync(process.execPath, [relaydBin, "enroll", "--no-pair"], {
      env: {
        ...process.env,
        CODEX_DATA_DIR: dataDir,
        RELAYD_ENROLL_URL: cloud.url,
        RELAYD_ENROLL_TOKEN: "tok-nopair",
        // Deliberately present: --no-pair must win over them.
        RELAYD_ENROLL_PAIRING_ID: "11111111-1111-4111-8111-111111111111",
        RELAYD_ENROLL_PAIRING_SECRET: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
      },
    });
    assert.match(stdout, /enrolled node-[0-9a-f]{16}/);
    assert.ok(!stdout.includes("trial device paired"), "pairing must not run under --no-pair");
    assert.ok(!stdout.includes("tok-nopair"), "token must never be printed");
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
