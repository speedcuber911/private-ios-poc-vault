import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const safeId = /^[A-Za-z0-9._:-]{1,160}$/;
const terminalDecisions = new Set(["accept", "acceptForSession", "decline", "cancel"]);

class ApprovalStore {
  constructor(directory) {
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  create(input) {
    const id = input.id && safeId.test(input.id) ? input.id : crypto.randomUUID();
    const record = {
      id,
      jobId: String(input.jobId || ""),
      provider: input.provider === "claude" ? "claude" : "codex",
      kind: String(input.kind || "tool"),
      title: cleanText(input.title, 180) || "Approval requested",
      reason: cleanText(input.reason, 1200),
      command: cleanText(input.command, 4000),
      cwd: cleanText(input.cwd, 1200),
      toolName: cleanText(input.toolName, 180),
      itemId: cleanText(input.itemId, 180),
      threadId: cleanText(input.threadId, 180),
      turnId: cleanText(input.turnId, 180),
      requestId: input.requestId ?? null,
      availableDecisions: cleanDecisions(input.availableDecisions),
      createdAt: new Date().toISOString(),
    };
    if (!record.jobId || !safeId.test(record.jobId)) throw new Error("approval job id is invalid");
    this.#writeAtomic(this.#requestPath(id), record);
    return record;
  }

  get(id) {
    if (!safeId.test(String(id || ""))) return null;
    const request = this.#read(this.#requestPath(id));
    if (!request) return null;
    const resolution = this.#read(this.#decisionPath(id));
    return { ...request, status: resolution ? "resolved" : "pending", resolution };
  }

  list({ jobId = null, status = null } = {}) {
    let names = [];
    try {
      names = fs.readdirSync(this.directory).filter((name) => name.endsWith(".request.json"));
    } catch {
      return [];
    }
    return names
      .map((name) => this.get(name.slice(0, -".request.json".length)))
      .filter(Boolean)
      .filter((record) => !jobId || record.jobId === jobId)
      .filter((record) => !status || record.status === status)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  }

  pendingCount(jobId) {
    return this.list({ jobId, status: "pending" }).length;
  }

  decide(id, decision, { decidedBy = "phone", message = "" } = {}) {
    const record = this.get(id);
    if (!record) throw Object.assign(new Error("approval not found"), { status: 404 });
    if (record.status !== "pending") throw Object.assign(new Error("approval is already resolved"), { status: 409 });
    if (!terminalDecisions.has(decision)) {
      throw Object.assign(new Error("decision must be accept, acceptForSession, decline, or cancel"), { status: 400 });
    }
    const resolution = {
      decision,
      decidedBy: cleanText(decidedBy, 80) || "phone",
      message: cleanText(message, 1000),
      decidedAt: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(this.#decisionPath(id), `${JSON.stringify(resolution)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw Object.assign(new Error("approval is already resolved"), { status: 409 });
      }
      throw error;
    }
    return { ...record, status: "resolved", resolution };
  }

  waitForDecision(id, { signal = null, pollMs = 200 } = {}) {
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (signal?.aborted) {
          reject(signal.reason || new Error("approval wait cancelled"));
          return;
        }
        const record = this.get(id);
        if (!record) {
          reject(new Error("approval request disappeared"));
          return;
        }
        if (record.resolution) {
          resolve(record.resolution);
          return;
        }
        timer = setTimeout(tick, pollMs);
        timer.unref?.();
      };
      let timer = setTimeout(tick, pollMs);
      timer.unref?.();
    });
  }

  cancelPendingForJob(jobId, message = "Job ended before this request was answered.") {
    for (const record of this.list({ jobId, status: "pending" })) {
      try {
        this.decide(record.id, "cancel", { decidedBy: "relay", message });
      } catch {
        // A simultaneous phone decision won the race.
      }
    }
  }

  prune({ maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
    const cutoff = Date.now() - maxAgeMs;
    for (const record of this.list()) {
      if (record.status !== "resolved" || Date.parse(record.resolution?.decidedAt || 0) >= cutoff) continue;
      for (const target of [this.#requestPath(record.id), this.#decisionPath(record.id)]) {
        try { fs.unlinkSync(target); } catch {}
      }
    }
  }

  #requestPath(id) { return path.join(this.directory, `${id}.request.json`); }
  #decisionPath(id) { return path.join(this.directory, `${id}.decision.json`); }

  #read(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }

  #writeAtomic(file, value) {
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, file);
  }
}

function cleanText(value, limit) {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").trim().slice(0, limit);
}

function cleanDecisions(value) {
  if (!Array.isArray(value)) return ["accept", "decline", "cancel"];
  const result = value.filter((entry) => terminalDecisions.has(entry));
  return result.length ? [...new Set(result)] : ["accept", "decline", "cancel"];
}

function publicApproval(record) {
  return {
    id: record.id,
    jobId: record.jobId,
    provider: record.provider,
    kind: record.kind,
    title: record.title,
    reason: record.reason || null,
    command: record.command || null,
    cwd: record.cwd || null,
    toolName: record.toolName || null,
    createdAt: record.createdAt,
    status: record.status,
    availableDecisions: record.availableDecisions,
    resolution: record.resolution ? {
      decision: record.resolution.decision,
      decidedAt: record.resolution.decidedAt,
      message: record.resolution.message || null,
    } : null,
  };
}

export { ApprovalStore, publicApproval, terminalDecisions };
