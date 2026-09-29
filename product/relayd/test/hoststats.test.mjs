import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  cpuPercent,
  cpuTimesFromCpus,
  usedPercent,
  evaluateMetric,
  createHostMonitor,
  parseProcNetDev,
  parseProcDiskstats,
  ioRate,
  streamHostStats,
  METRICS,
  coreTimesFromCpus,
  corePercents,
  parseProcStat,
  topProcesses,
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
    freshMs: 2_000,
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

test("live stream sends full history once, incremental samples, and stops on close", () => {
  let t = 1_000;
  let cpu = 10;
  const monitor = createHostMonitor({
    now: () => t,
    sampleMs: 15_000,
    freshMs: 2_000,
    collect: () => ({
      cpuTimes: { idle: cpu, total: cpu * 2 },
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

  const req = new EventEmitter();
  const writes = [];
  const res = new EventEmitter();
  res.writeHead = (status, headers) => {
    assert.equal(status, 200);
    assert.equal(headers["content-type"], "text/event-stream");
  };
  res.write = (chunk) => { writes.push(chunk); return true; };

  let tick;
  let cleared = 0;
  let closed = 0;
  streamHostStats(req, res, {
    monitor,
    onClose: () => { closed += 1; },
    setIntervalFn: (callback, delay) => {
      assert.equal(delay, 2_000);
      tick = callback;
      return { unref() {} };
    },
    clearIntervalFn: () => { cleared += 1; },
  });

  assert.match(writes.join(""), /event: snapshot/);
  assert.equal(JSON.parse(writes[0].match(/data: (.*)\n\n/s)[1]).history.length, 1);

  t += 2_000;
  tick();
  assert.match(writes.at(-1), /event: sample/);
  assert.equal(JSON.parse(writes.at(-1).match(/data: (.*)\n\n/s)[1]).history.length, 1);

  tick();
  assert.equal(writes.at(-1), ": heartbeat\n\n");

  req.emit("close");
  req.emit("close");
  assert.equal(cleared, 1);
  assert.equal(closed, 1);
  monitor.stop();
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

test("per-core percents pair each core's times delta", () => {
  const before = coreTimesFromCpus([
    { times: { user: 10, idle: 90, sys: 0 } },
    { times: { user: 50, idle: 50, sys: 0 } },
  ]);
  const after = coreTimesFromCpus([
    { times: { user: 60, idle: 140, sys: 0 } },
    { times: { user: 140, idle: 60, sys: 0 } },
  ]);
  assert.deepEqual(corePercents(before, after), [50, 90]);
  assert.equal(corePercents(null, after), null);
  assert.equal(corePercents(before, after.slice(0, 1)), null);
});

test("proc stat parser survives spaces and parens in comm", () => {
  const tail = "S 1 1 1 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 8 0 100 123456789 2048";
  assert.deepEqual(parseProcStat(`4121 (claude) ${tail}`), { name: "claude", ticks: 300, rssPages: 2048 });
  assert.equal(parseProcStat(`77 (tmux: server (1)) ${tail}`).name, "tmux: server (1)");
  assert.equal(parseProcStat("garbage"), null);
});

test("top processes rank by machine share and skip reused pids", () => {
  const prev = new Map([
    [1, { name: "relayd", ticks: 1000, rssPages: 10 }],
    [2, { name: "claude", ticks: 500, rssPages: 100 }],
    [3, { name: "old", ticks: 10, rssPages: 1 }],
  ]);
  const next = new Map([
    [1, { name: "relayd", ticks: 1020, rssPages: 10 }],
    [2, { name: "claude", ticks: 900, rssPages: 100 }],
    [3, { name: "reused", ticks: 9000, rssPages: 1 }],
    [4, { name: "new", ticks: 5, rssPages: 1 }],
  ]);
  // 400 ticks over 2 s on 4 cores = 2 core-seconds/s of 4 = 50% of the machine.
  const rows = topProcesses(prev, next, 2, 4);
  assert.deepEqual(rows.map((row) => row.name), ["claude", "relayd"]);
  assert.equal(rows[0].cpuPercent, 50);
  assert.equal(rows[0].memBytes, 100 * 4096);
  assert.equal(rows[1].cpuPercent, 2.5);
  assert.equal(topProcesses(null, next, 2, 4), null);
  assert.equal(topProcesses(prev, next, 0, 4), null);
});

test("snapshot carries per-core series and process sparklines; stream strips core history", () => {
  let t = 1_000;
  let step = 0;
  const monitor = createHostMonitor({
    now: () => t,
    sampleMs: 15_000,
    freshMs: 2_000,
    collect: () => {
      step += 1;
      return {
        cpuTimes: { idle: step, total: step * 2 },
        cpuPercent: 20,
        cpuCount: 2,
        corePercents: [10 * step, 5],
        processes: [
          { pid: 9, name: "claude", cpuPercent: step, memBytes: 4096 },
          { pid: 7, name: "relayd", cpuPercent: 1, memBytes: 2048 },
        ],
        memory: { usedBytes: 20, totalBytes: 100, availableBytes: 80 },
        disk: { usedBytes: 30, totalBytes: 100, freeBytes: 70, path: "/" },
        load1: 0.2,
        load5: 0.2,
        load15: 0.2,
        uptimeSec: 10,
        hostname: "box-1",
        platform: "linux",
        arch: "x64",
      };
    },
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => {},
  });
  t += 5_000;
  const snap = monitor.snapshot();
  assert.deepEqual(snap.cpu.cores, [20, 5]);
  assert.deepEqual(snap.cpu.coreHistory, [[10, 20], [5, 5]]);
  assert.deepEqual(snap.processes[0].history, [1, 2]);
  assert.equal(snap.processes[1].name, "relayd");

  const req = new EventEmitter();
  const res = new EventEmitter();
  const writes = [];
  res.writeHead = () => {};
  res.write = (chunk) => { writes.push(chunk); return true; };
  let tick;
  streamHostStats(req, res, {
    monitor,
    setIntervalFn: (callback) => { tick = callback; return { unref() {} }; },
    clearIntervalFn: () => {},
  });
  const opening = JSON.parse(writes[0].match(/data: (.*)\n\n/s)[1]);
  assert.deepEqual(opening.cpu.coreHistory, [[10, 20], [5, 5]]);
  t += 2_000;
  tick();
  const sample = JSON.parse(writes.at(-1).match(/data: (.*)\n\n/s)[1]);
  assert.deepEqual(sample.cpu.cores, [30, 5]);
  assert.equal(sample.cpu.coreHistory, undefined);
  assert.deepEqual(sample.processes[0].history, [1, 2, 3]);
  req.emit("close");
  monitor.stop();
});
