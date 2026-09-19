import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-machine-stats-"));
process.env.CODEX_DATA_DIR = path.join(root, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(root, "ws");
fs.mkdirSync(path.join(root, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(root, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";
process.env.RELAYD_PAIRING_ENABLED = "false";

const { routeRequest } = await import("../src/server.mjs");
const { startHostMonitor } = await import("../src/hoststats.mjs");

test("GET /v1/machine/stats returns the live snapshot", async () => {
  const monitor = startHostMonitor({
    collect: () => ({
      cpuTimes: { idle: 1, total: 2 },
      cpuPercent: 11,
      cpuCount: 2,
      memory: { usedBytes: 22, totalBytes: 100, availableBytes: 78 },
      disk: { usedBytes: 33, totalBytes: 100, freeBytes: 67, path: "/" },
      load1: 0.1,
      load5: 0.1,
      load15: 0.1,
      uptimeSec: 9,
      hostname: "box-1",
      platform: "linux",
      arch: "x64",
      network: { rxBytesPerSec: 1200, txBytesPerSec: 300 },
      io: {
        readBytesPerSec: 4096,
        writeBytesPerSec: 512,
        readOpsPerSec: 2,
        writeOpsPerSec: 1,
      },
    }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });

  const server = http.createServer((req, res) => {
    routeRequest(req, res).catch((error) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/machine/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.host.hostname, "box-1");
    assert.equal(body.cpu.usedPercent, 11);
    assert.equal(body.memory.usedPercent, 22);
    assert.equal(body.disk.usedPercent, 33);
    assert.equal(body.network.rxBytesPerSec, 1200);
    assert.equal(body.io.writeBytesPerSec, 512);
    assert.ok(Array.isArray(body.history));
    assert.ok(Array.isArray(body.alerts));
    assert.equal(body.history.at(-1).netRxBytesPerSec, 1200);
  } finally {
    monitor.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});
