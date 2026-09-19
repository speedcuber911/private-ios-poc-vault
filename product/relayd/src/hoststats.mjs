// Host usage sampler. This is the CloudWatch-agent role for a Relay node:
// collect CPU, memory, disk, load, and Linux network/disk I/O on the
// machine itself, keep about an hour of samples the phone can graph, and
// fire a content-free `node.pressure` event
// when something stays high. The phone picks the snapshot up over the
// existing paired TLS path — nothing is shipped to AWS or the control plane
// except the event type, when the node is registered for push.

import fs from "node:fs";
import os from "node:os";

const DEFAULT_SAMPLE_MS = 15_000;
const DEFAULT_FRESH_MS = 5_000;
const DEFAULT_HEARTBEAT_MS = 120_000;
const DEFAULT_HISTORY = 720;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;
const DISK_FREE_FLOOR_BYTES = 1_000_000_000;
const DISK_FREE_FLOOR_MIN_TOTAL = 2_000_000_000;

const METRICS = {
  cpu: { fire: 90, clear: 70, consecutive: 3 },
  memory: { fire: 90, clear: 70, consecutive: 3 },
  disk: { fire: 90, clear: 80, consecutive: 2 },
};

function envInt(name, fallback, min, max) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function round1(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 10) / 10;
}

export function usedPercent(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return round1((used / total) * 100);
}

export function cpuTimesFromCpus(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of Array.isArray(cpus) ? cpus : []) {
    const times = cpu?.times || {};
    const slice = Object.values(times).reduce((sum, value) => sum + (Number(value) || 0), 0);
    idle += Number(times.idle) || 0;
    total += slice;
  }
  return { idle, total };
}

export function cpuPercent(prev, next) {
  if (!prev || !next) return null;
  const idle = next.idle - prev.idle;
  const total = next.total - prev.total;
  if (total <= 0) return null;
  return round1((1 - idle / total) * 100);
}

function readLinuxMemory() {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf8");
    const read = (key) => {
      const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return match ? Number(match[1]) * 1024 : null;
    };
    const totalBytes = read("MemTotal");
    const availableBytes = read("MemAvailable");
    if (!Number.isFinite(totalBytes) || !Number.isFinite(availableBytes)) return null;
    return {
      totalBytes,
      availableBytes,
      usedBytes: Math.max(0, totalBytes - availableBytes),
    };
  } catch {
    return null;
  }
}

function readMemory() {
  const linux = process.platform === "linux" ? readLinuxMemory() : null;
  if (linux) return linux;
  const totalBytes = os.totalmem();
  const availableBytes = os.freemem();
  return {
    totalBytes,
    availableBytes,
    usedBytes: Math.max(0, totalBytes - availableBytes),
  };
}

export function readDisk(target) {
  try {
    const stats = fs.statfsSync(target);
    const blockSize = Number(stats.bsize);
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
    return {
      path: target,
      totalBytes,
      freeBytes,
      usedBytes: Math.max(0, totalBytes - freeBytes),
    };
  } catch {
    return null;
  }
}

const SKIP_NET_IFACE = /^(lo|lo\d+|veth|br-|docker|cni|flannel|tun|tap|awdl|llw|utun|anpi)/i;
const WHOLE_DISK = /^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parseProcNetDev(text) {
  const totals = { rxBytes: 0, txBytes: 0, rxPackets: 0, txPackets: 0 };
  for (const line of String(text || "").split("\n")) {
    const match = line.match(/^\s*([A-Za-z0-9._-]+):\s*(.*)$/);
    if (!match || SKIP_NET_IFACE.test(match[1])) continue;
    const cols = match[2].trim().split(/\s+/).map(Number);
    if (cols.length < 9 || cols.some((value) => !Number.isFinite(value))) continue;
    totals.rxBytes += cols[0];
    totals.rxPackets += cols[1];
    totals.txBytes += cols[8];
    totals.txPackets += cols[9];
  }
  return totals;
}

export function parseProcDiskstats(text) {
  const totals = { readBytes: 0, writeBytes: 0, readOps: 0, writeOps: 0 };
  for (const line of String(text || "").split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 14 || !WHOLE_DISK.test(cols[2])) continue;
    const readOps = Number(cols[3]);
    const readSectors = Number(cols[5]);
    const writeOps = Number(cols[7]);
    const writeSectors = Number(cols[9]);
    if (![readOps, readSectors, writeOps, writeSectors].every(Number.isFinite)) continue;
    totals.readOps += readOps;
    totals.writeOps += writeOps;
    totals.readBytes += readSectors * 512;
    totals.writeBytes += writeSectors * 512;
  }
  return totals;
}

export function ioRate(prev, next, elapsedSec, key) {
  if (!prev || !next || !Number.isFinite(elapsedSec) || elapsedSec <= 0) return null;
  const delta = next[key] - prev[key];
  if (!Number.isFinite(delta) || delta < 0) return null;
  return Math.round(delta / elapsedSec);
}

function readLinuxIOCounters() {
  try {
    return {
      net: parseProcNetDev(fs.readFileSync("/proc/net/dev", "utf8")),
      disk: parseProcDiskstats(fs.readFileSync("/proc/diskstats", "utf8")),
    };
  } catch {
    return null;
  }
}

export function collectHostSample({
  diskPath = "/",
  prevCpu = null,
  prevIO = null,
  elapsedSec = null,
} = {}) {
  const cpus = os.cpus();
  const times = cpuTimesFromCpus(cpus);
  const memory = readMemory();
  const disk = readDisk(diskPath);
  const load = os.loadavg();
  const ioCounters = process.platform === "linux" ? readLinuxIOCounters() : null;
  const net = ioCounters?.net;
  const diskIO = ioCounters?.disk;
  return {
    cpuTimes: times,
    cpuPercent: cpuPercent(prevCpu, times),
    cpuCount: cpus.length,
    memory,
    disk,
    load1: load[0],
    load5: load[1],
    load15: load[2],
    uptimeSec: os.uptime(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    ioCounters,
    network: {
      rxBytesPerSec: ioRate(prevIO?.net, net, elapsedSec, "rxBytes"),
      txBytesPerSec: ioRate(prevIO?.net, net, elapsedSec, "txBytes"),
    },
    io: {
      readBytesPerSec: ioRate(prevIO?.disk, diskIO, elapsedSec, "readBytes"),
      writeBytesPerSec: ioRate(prevIO?.disk, diskIO, elapsedSec, "writeBytes"),
      readOpsPerSec: ioRate(prevIO?.disk, diskIO, elapsedSec, "readOps"),
      writeOpsPerSec: ioRate(prevIO?.disk, diskIO, elapsedSec, "writeOps"),
    },
  };
}

function emptyAlertState() {
  return { streak: 0, firing: false, lastPostedAt: 0 };
}

export function evaluateMetric(state, value, spec, now, cooldownMs, extraFire = false) {
  const current = state && typeof state === "object" ? state : emptyAlertState();
  if ((value == null || !Number.isFinite(value)) && !extraFire) {
    return { state: { ...current, streak: 0 }, fired: false };
  }
  const over = extraFire || (Number.isFinite(value) && value >= spec.fire);
  const streak = over ? current.streak + 1 : 0;
  let firing = current.firing;
  let lastPostedAt = current.lastPostedAt;
  let fired = false;
  if (!firing && streak >= spec.consecutive) {
    firing = true;
    if (!lastPostedAt || now - lastPostedAt >= cooldownMs) {
      fired = true;
      lastPostedAt = now;
    }
  } else if (firing && !over && Number.isFinite(value) && value <= spec.clear) {
    firing = false;
  }
  return { state: { streak, firing, lastPostedAt }, fired };
}

function publicResource(usedBytes, totalBytes, extra = {}) {
  const used = usedPercent(usedBytes, totalBytes);
  return {
    usedPercent: used,
    usedBytes: Number.isFinite(usedBytes) ? usedBytes : null,
    totalBytes: Number.isFinite(totalBytes) ? totalBytes : null,
    ...extra,
  };
}

function toPublic(raw, sampledAt, jobs) {
  const memory = raw.memory || {};
  const disk = raw.disk || {};
  return {
    ok: true,
    sampledAt,
    host: {
      hostname: raw.hostname || null,
      platform: raw.platform || null,
      arch: raw.arch || null,
      uptimeSec: Number.isFinite(raw.uptimeSec) ? Math.round(raw.uptimeSec) : null,
    },
    cpu: {
      usedPercent: raw.cpuPercent,
      count: Number.isFinite(raw.cpuCount) ? raw.cpuCount : null,
      load1: round1(raw.load1),
      load5: round1(raw.load5),
      load15: round1(raw.load15),
    },
    memory: publicResource(memory.usedBytes, memory.totalBytes, {
      availableBytes: Number.isFinite(memory.availableBytes) ? memory.availableBytes : null,
    }),
    disk: publicResource(disk.usedBytes, disk.totalBytes, {
      freeBytes: Number.isFinite(disk.freeBytes) ? disk.freeBytes : null,
      path: disk.path || null,
    }),
    jobs: {
      active: Number.isFinite(jobs?.active) ? jobs.active : 0,
      queued: Number.isFinite(jobs?.queued) ? jobs.queued : 0,
    },
    network: {
      rxBytesPerSec: Number.isFinite(raw.network?.rxBytesPerSec) ? raw.network.rxBytesPerSec : null,
      txBytesPerSec: Number.isFinite(raw.network?.txBytesPerSec) ? raw.network.txBytesPerSec : null,
    },
    io: {
      readBytesPerSec: Number.isFinite(raw.io?.readBytesPerSec) ? raw.io.readBytesPerSec : null,
      writeBytesPerSec: Number.isFinite(raw.io?.writeBytesPerSec) ? raw.io.writeBytesPerSec : null,
      readOpsPerSec: Number.isFinite(raw.io?.readOpsPerSec) ? raw.io.readOpsPerSec : null,
      writeOpsPerSec: Number.isFinite(raw.io?.writeOpsPerSec) ? raw.io.writeOpsPerSec : null,
    },
  };
}

function diskIsCriticallyLow(disk) {
  if (!disk || !Number.isFinite(disk.freeBytes) || !Number.isFinite(disk.totalBytes)) return false;
  return disk.totalBytes >= DISK_FREE_FLOOR_MIN_TOTAL && disk.freeBytes < DISK_FREE_FLOOR_BYTES;
}

let defaultMonitor = null;

export function createHostMonitor({
  now = () => Date.now(),
  sampleMs = envInt("RELAYD_HOST_SAMPLE_MS", DEFAULT_SAMPLE_MS, 5_000, 120_000),
  freshMs = envInt("RELAYD_HOST_FRESH_MS", DEFAULT_FRESH_MS, 2_000, 60_000),
  heartbeatMs = envInt("RELAYD_HOST_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, 30_000, 600_000),
  historyLimit = envInt("RELAYD_HOST_HISTORY", DEFAULT_HISTORY, 12, 720),
  cooldownMs = envInt("RELAYD_HOST_ALERT_COOLDOWN_MS", DEFAULT_COOLDOWN_MS, 60_000, 24 * 3600 * 1000),
  diskPath = process.env.RELAYD_DISK_PATH || "/",
  collect = collectHostSample,
  jobsReader = () => ({ active: 0, queued: 0 }),
  emit = null,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let cloud = null;
  let prevCpu = null;
  let prevIO = null;
  let prevSampleMs = null;
  let lastSnapshot = null;
  const history = [];
  const alerts = {
    cpu: emptyAlertState(),
    memory: emptyAlertState(),
    disk: emptyAlertState(),
  };

  function setCloud(next) {
    cloud = next && typeof next === "object" ? next : null;
    if (cloud?.heartbeat) void Promise.resolve(cloud.heartbeat()).catch(() => null);
  }

  function publicAlerts() {
    return ["cpu", "memory", "disk"].map((kind) => ({
      kind,
      state: alerts[kind].firing ? "firing" : "ok",
    }));
  }

  function sample() {
    const t = now();
    const sampledAt = new Date(t).toISOString();
    const elapsedSec = prevSampleMs == null ? null : (t - prevSampleMs) / 1000;
    const raw = collect({ diskPath, prevCpu, prevIO, elapsedSec }) || {};
    if (raw.cpuTimes) prevCpu = raw.cpuTimes;
    if (raw.ioCounters) prevIO = raw.ioCounters;
    prevSampleMs = t;
    let jobs = { active: 0, queued: 0 };
    try {
      jobs = jobsReader() || jobs;
    } catch {
      /* job counts are decorative; a reader fault must not freeze samples */
    }
    const snapshot = toPublic(raw, sampledAt, jobs);
    lastSnapshot = snapshot;
    history.push({
      ts: sampledAt,
      cpuPercent: snapshot.cpu.usedPercent,
      memoryUsedPercent: snapshot.memory.usedBytes != null ? snapshot.memory.usedPercent : null,
      diskUsedPercent: snapshot.disk.usedBytes != null ? snapshot.disk.usedPercent : null,
      netRxBytesPerSec: snapshot.network.rxBytesPerSec,
      netTxBytesPerSec: snapshot.network.txBytesPerSec,
      diskReadBytesPerSec: snapshot.io.readBytesPerSec,
      diskWriteBytesPerSec: snapshot.io.writeBytesPerSec,
    });
    if (history.length > historyLimit) history.shift();

    const nextCpu = evaluateMetric(alerts.cpu, snapshot.cpu.usedPercent, METRICS.cpu, t, cooldownMs);
    const nextMemory = evaluateMetric(alerts.memory, snapshot.memory.usedPercent, METRICS.memory, t, cooldownMs);
    const nextDisk = evaluateMetric(
      alerts.disk,
      snapshot.disk.usedPercent,
      METRICS.disk,
      t,
      cooldownMs,
      diskIsCriticallyLow(snapshot.disk),
    );
    alerts.cpu = nextCpu.state;
    alerts.memory = nextMemory.state;
    alerts.disk = nextDisk.state;
    const fired = [
      nextCpu.fired ? "cpu" : null,
      nextMemory.fired ? "memory" : null,
      nextDisk.fired ? "disk" : null,
    ].filter(Boolean);
    if (fired.length) {
      emit?.("node.pressure", { kinds: fired });
      if (cloud?.postEvent) void Promise.resolve(cloud.postEvent("node.pressure")).catch(() => null);
    }
    return snapshot;
  }

  function snapshot() {
    const staleAfter = Math.min(Number(freshMs) || DEFAULT_FRESH_MS, sampleMs);
    const age = prevSampleMs == null ? Infinity : now() - prevSampleMs;
    if (!lastSnapshot || age >= staleAfter) {
      try {
        sample();
      } catch (error) {
        console.warn(`[relayd] host sample failed: ${error?.message ?? error}`);
      }
    }
    const current = lastSnapshot;
    if (!current) {
      return {
        ok: false,
        sampledAt: new Date(now()).toISOString(),
        host: { hostname: null, platform: null, arch: null, uptimeSec: null },
        cpu: { usedPercent: null, count: null, load1: null, load5: null, load15: null },
        memory: { usedPercent: null, usedBytes: null, totalBytes: null, availableBytes: null },
        disk: { usedPercent: null, usedBytes: null, totalBytes: null, freeBytes: null, path: null },
        jobs: { active: 0, queued: 0 },
        network: { rxBytesPerSec: null, txBytesPerSec: null },
        io: {
          readBytesPerSec: null,
          writeBytesPerSec: null,
          readOpsPerSec: null,
          writeOpsPerSec: null,
        },
        alerts: publicAlerts(),
        history: [],
      };
    }
    return {
      ...current,
      alerts: publicAlerts(),
      history: history.slice(),
    };
  }

  function stop() {
    if (sampleTimer) clearIntervalFn(sampleTimer);
    if (heartbeatTimer) clearIntervalFn(heartbeatTimer);
  }

  const sampleTimer = setIntervalFn(() => {
    try {
      sample();
    } catch (error) {
      console.warn(`[relayd] host sample failed: ${error?.message ?? error}`);
    }
  }, sampleMs);

  const heartbeatTimer = setIntervalFn(() => {
    if (!cloud?.heartbeat) return;
    void Promise.resolve(cloud.heartbeat()).catch(() => null);
  }, heartbeatMs);
  heartbeatTimer?.unref?.();

  sample();

  return {
    sample,
    snapshot,
    setCloud,
    stop,
    alerts,
    streamIntervalMs: Math.min(sampleMs, freshMs),
  };
}

export function getHostMonitor() {
  if (!defaultMonitor) defaultMonitor = createHostMonitor();
  return defaultMonitor;
}

export function startHostMonitor(options) {
  defaultMonitor?.stop?.();
  defaultMonitor = createHostMonitor(options);
  return defaultMonitor;
}

// GET /v1/machine/stats/stream — an ephemeral, screen-scoped SSE feed.
//
// The first event carries the complete bounded history so the chart can draw
// immediately. Later events carry only the newest point; repeatedly sending
// the whole history would make bandwidth and JSON decoding grow for as long as
// the screen stayed open. snapshot() performs the at-most-once fresh sample,
// so multiple paired viewers do not multiply host reads.
export function streamHostStats(req, res, {
  monitor = getHostMonitor(),
  onClose = () => {},
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  let closed = false;
  let blocked = false;
  let timer = null;
  let lastSampledAt = null;

  function close() {
    if (closed) return;
    closed = true;
    if (timer) clearIntervalFn(timer);
    onClose();
  }

  function write(event, payload) {
    if (closed || blocked) return false;
    try {
      const writable = res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
      if (writable === false) {
        blocked = true;
        res.once?.("drain", () => { blocked = false; });
      }
      return true;
    } catch {
      close();
      return false;
    }
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  req.once?.("close", close);
  req.once?.("aborted", close);

  const initial = monitor.snapshot();
  lastSampledAt = initial.sampledAt;
  write("snapshot", initial);
  if (closed) return close;

  const intervalMs = Math.max(1_000, Number(monitor.streamIntervalMs) || DEFAULT_FRESH_MS);
  timer = setIntervalFn(() => {
    if (closed || blocked) return;
    const next = monitor.snapshot();
    if (next.sampledAt === lastSampledAt) {
      try {
        res.write(": heartbeat\n\n");
      } catch {
        close();
      }
      return;
    }
    lastSampledAt = next.sampledAt;
    write("sample", {
      ...next,
      history: Array.isArray(next.history) ? next.history.slice(-1) : [],
    });
  }, intervalMs);
  timer?.unref?.();
  return close;
}

export {
  DEFAULT_SAMPLE_MS,
  DEFAULT_FRESH_MS,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_COOLDOWN_MS,
  METRICS,
};
