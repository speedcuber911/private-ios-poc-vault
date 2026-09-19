import test from "node:test";
import assert from "node:assert/strict";

import {
  cpuPercent,
  cpuTimesFromCpus,
  usedPercent,
  evaluateMetric,
  createHostMonitor,
  parseProcNetDev,
  parseProcDiskstats,
  ioRate,
  METRICS,
} from "../src/hoststats.mjs";

test("cpu percent is the idle-complement of a times delta", () => {
  const prev = { idle: 80, total: 100 };
  const next = { idle: 85, total: 200 };
  assert.equal(cpuPercent(prev, next), 95);
  assert.equal(cpuPercent(null, next), null);
  assert.equal(usedPercent(250, 1000), 25);
  assert.equal(usedPercent(1, 0), null);
});

test("cpuTimesFromCpus sums every core", () => {
  const times = cpuTimesFromCpus([
    { times: { user: 10, idle: 90, sys: 0, irq: 0, nice: 0 } },
    { times: { user: 20, idle: 70, sys: 10, irq: 0, nice: 0 } },
  ]);
  assert.equal(times.idle, 160);
  assert.equal(times.total, 200);
});

test("evaluateMetric fires after consecutive highs and cools down", () => {
  const spec = METRICS.cpu;
  let state = { streak: 0, firing: false, lastPostedAt: 0 };
  let fired = 0;
  for (let i = 0; i < 3; i += 1) {
    const result = evaluateMetric(state, 95, spec, 1_000 + i, 60_000);
    state = result.state;
    if (result.fired) fired += 1;
  }
  assert.equal(fired, 1);
  assert.equal(state.firing, true);

  const duringCooldown = evaluateMetric(state, 96, spec, 2_000, 60_000);
  assert.equal(duringCooldown.fired, false);
  assert.equal(duringCooldown.state.firing, true);

  const cleared = evaluateMetric(duringCooldown.state, 40, spec, 3_000, 60_000);
  assert.equal(cleared.state.firing, false);
  assert.equal(cleared.fired, false);
});

function scriptedCollect(readings) {
  let index = 0;
  return () => {
    const reading = readings[Math.min(index, readings.length - 1)];
    index += 1;
    return {
      cpuTimes: { idle: index, total: index * 2 },
      cpuPercent: reading.cpu,
      cpuCount: 2,
      memory: { usedBytes: reading.memory, totalBytes: 100, availableBytes: 100 - reading.memory },
      disk: { usedBytes: reading.disk, totalBytes: 100, freeBytes: 100 - reading.disk, path: "/" },
      load1: 0.2,
      load5: 0.2,
      load15: 0.2,
      uptimeSec: 10,
      hostname: "box-1",
      platform: "linux",
      arch: "x64",
    };
  };
}

test("monitor posts node.pressure once CPU stays high", () => {
  const posted = [];
  const emitted = [];
  const highs = Array.from({ length: 4 }, () => ({ cpu: 95, memory: 20, disk: 20 }));
  const monitor = createHostMonitor({
    now: (() => {
      let t = 1_000;
      return () => {
        t += 1;
        return t;
      };
    })(),
    collect: scriptedCollect(highs),
    emit: (name, data) => emitted.push({ name, data }),
    jobsReader: () => ({ active: 2, queued: 1 }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
    cooldownMs: 1,
  });
  monitor.setCloud({
    postEvent: (type) => posted.push(type),
    heartbeat: () => posted.push("heartbeat"),
  });
  monitor.sample();
  monitor.sample();
  const snap = monitor.snapshot();
  monitor.stop();

  assert.equal(snap.host.hostname, "box-1");
  assert.equal(snap.jobs.active, 2);
  assert.equal(snap.cpu.usedPercent, 95);
  assert.ok(snap.alerts.some((alert) => alert.kind === "cpu" && alert.state === "firing"));
  assert.ok(posted.includes("node.pressure"));
  assert.ok(emitted.some((event) => event.name === "node.pressure" && event.data.kinds.includes("cpu")));
  assert.ok(snap.history.length >= 3);
});

test("snapshot takes a new reading when the last one is stale", () => {
  let t = 1_000;
  let cpu = 10;
  const monitor = createHostMonitor({
    now: () => t,
    sampleMs: 15_000,
    freshMs: 5_000,
    collect: () => ({
      cpuTimes: { idle: 1, total: 2 },
      cpuPercent: cpu++,
      cpuCount: 2,
      memory: { usedBytes: 20, totalBytes: 100, availableBytes: 80 },
      disk: { usedBytes: 30, totalBytes: 100, freeBytes: 70, path: "/" },
      load1: 0.2,
      load5: 0.2,
      load15: 0.2,
      uptimeSec: 10,
      hostname: "box-1",
      platform: "linux",
      arch: "x64",
    }),
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  const first = monitor.snapshot();
  const again = monitor.snapshot();
  t += 5_000;
  const second = monitor.snapshot();
  monitor.stop();

  assert.equal(again.sampledAt, first.sampledAt);
  assert.equal(again.history.length, first.history.length);
  assert.notEqual(second.sampledAt, first.sampledAt);
  assert.ok(second.history.length > first.history.length);
  assert.notEqual(second.cpu.usedPercent, first.cpu.usedPercent);
});

test("proc parsers skip loopback, virtual nics, and partition disks", () => {
  const net = parseProcNetDev(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 20 0 0 0 0 0 0 3000 15 0 0 0 0 0 0
  ens5: 2000 5 0 0 0 0 0 0 1000 4 0 0 0 0 0 0
docker0: 9999 1 0 0 0 0 0 0 9999 1 0 0 0 0 0 0
`);
  assert.equal(net.rxBytes, 7000);
  assert.equal(net.txBytes, 4000);

  const disk = parseProcDiskstats(`
   8       0 sda 100 0 200 0 50 0 80 0 0 0 0 0 0 0
   8       1 sda1 10 0 20 0 5 0 8 0 0 0 0 0 0 0
   7       0 loop0 1 0 2 0 0 0 0 0 0 0 0 0 0 0
 259       0 nvme0n1 10 0 40 0 6 0 12 0 0 0 0 0 0 0
`);
  assert.equal(disk.readOps, 110);
  assert.equal(disk.writeOps, 56);
  assert.equal(disk.readBytes, 240 * 512);
  assert.equal(disk.writeBytes, 92 * 512);
  assert.equal(ioRate({ rxBytes: 1000 }, { rxBytes: 4000 }, 2, "rxBytes"), 1500);
  assert.equal(ioRate(null, { rxBytes: 4000 }, 2, "rxBytes"), null);
});
