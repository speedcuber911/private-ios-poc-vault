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
      questions: cleanQuestions(input.questions),
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

  decide(id, decision, { decidedBy = "phone", message = "", answers = null } = {}) {
    const record = this.get(id);
    if (!record) throw Object.assign(new Error("approval not found"), { status: 404 });
    if (record.status !== "pending") throw Object.assign(new Error("approval is already resolved"), { status: 409 });
    if (!terminalDecisions.has(decision)) {
      throw Object.assign(new Error("decision must be accept, acceptForSession, decline, or cancel"), { status: 400 });
    }
    const cleanedAnswers = cleanAnswers(record, answers);
    // Accepting a question without an answer would hand the agent an empty
    // reply it reads as the user's choice. Refuse it; Deny is the way out.
    if (record.questions && decision.startsWith("accept") && !cleanedAnswers) {
      throw Object.assign(new Error("answer the question in Relay to continue"), { status: 400 });
    }
    const resolution = {
      decision,
      decidedBy: cleanText(decidedBy, 80) || "phone",
      message: cleanText(message, 1000),
      ...(cleanedAnswers && decision.startsWith("accept") ? { answers: cleanedAnswers } : {}),
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

  waitForDecision(id, { signal = null, pollMs = 200, timeoutMs = null } = {}) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const keepAliveForTimeout = timeoutMs != null && timeoutMs >= 0;
      const tick = () => {
        if (signal?.aborted) {
          reject(signal.reason || new Error("approval wait cancelled"));
          return;
        }
        if (keepAliveForTimeout && Date.now() - startedAt >= timeoutMs) {
          reject(Object.assign(
            new Error("Timed out waiting for an approval decision from Relay."),
            { code: "approval_timeout" },
          ));
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
        // Unref only when there is no bounded wait; otherwise the event loop can
        // drain and cancel an approval timeout before it fires.
        if (!keepAliveForTimeout) timer.unref?.();
      };
      let timer = setTimeout(tick, pollMs);
      if (!keepAliveForTimeout) timer.unref?.();
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

const questionKinds = new Set(["choice", "text", "number"]);

// Answers are keyed by this form of a question's text, so the runner can match
// them back to the exact text the agent wrote.
function questionKey(value) {
  return cleanText(value, 1000);
}

// The questions an agent asked (Claude's AskUserQuestion), in its order.
function cleanQuestions(value) {
  if (!Array.isArray(value)) return null;
  const questions = value.slice(0, 4).map((entry) => {
    const question = questionKey(entry?.question);
    if (!question) return null;
    const options = Array.isArray(entry.options)
      ? entry.options.slice(0, 8)
        .map((option) => ({
          label: cleanText(option?.label, 200),
          description: cleanText(option?.description, 600) || null,
        }))
        .filter((option) => option.label)
      : [];
    const kind = questionKinds.has(entry.kind) ? entry.kind : "choice";
    return {
      question,
      header: cleanText(entry.header, 60) || null,
      kind: kind === "choice" && options.length === 0 ? "text" : kind,
      multiSelect: entry.multiSelect === true,
      options,
      placeholder: cleanText(entry.placeholder, 200) || null,
    };
  }).filter(Boolean);
  return questions.length ? questions : null;
}

// Answers keyed by question text. A multi-select answer may arrive as a list;
// the agent takes it comma-joined, as its own terminal dialog sends it.
function cleanAnswers(record, value) {
  if (value === null || value === undefined) return null;
  if (!record.questions) {
    throw Object.assign(new Error("answers apply only to questions"), { status: 400 });
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw Object.assign(new Error("answers must be an object keyed by question"), { status: 400 });
  }
  const known = new Set(record.questions.map((entry) => entry.question));
  const answers = {};
  for (const [question, raw] of Object.entries(value)) {
    if (!known.has(question)) {
      throw Object.assign(new Error("answers name a question that was not asked"), { status: 400 });
    }
    const parts = Array.isArray(raw) ? raw : [raw];
    if (!parts.every((part) => typeof part === "string")) {
      throw Object.assign(new Error("each answer must be text"), { status: 400 });
    }
    const answer = cleanText(parts.map((part) => cleanText(part, 4000)).filter(Boolean).join(", "), 4000);
    if (answer) answers[question] = answer;
  }
  return Object.keys(answers).length ? answers : null;
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
    questions: record.questions || null,
    resolution: record.resolution ? {
      decision: record.resolution.decision,
      decidedAt: record.resolution.decidedAt,
      message: record.resolution.message || null,
      answers: record.resolution.answers || null,
    } : null,
  };
}

export { ApprovalStore, publicApproval, questionKey, terminalDecisions };
