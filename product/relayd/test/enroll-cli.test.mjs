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
