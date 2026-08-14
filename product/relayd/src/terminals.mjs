import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { AppServerClient } from "./appserver-client.mjs";

function createTerminalService({
  codexBin,
  runHome,
  codexHome,
  resolveWorkspaceById,
  readBody,
  sendJson,
  sendError,
  appendAudit = () => {},
  maxSessions = 4,
  maxOutputBytes = 1024 * 1024,
}) {
  const sessions = new Map();

  async function route(req, res, url) {
    if (url.pathname === "/v1/codex/terminals" && req.method === "GET") {
      const workspaceId = url.searchParams.get("workspaceId")?.trim() || null;
      sendJson(res, 200, { terminals: [...sessions.values()].filter((session) => !workspaceId || session.workspaceId === workspaceId).map(publicTerminal) });
      return true;
    }
    if (url.pathname === "/v1/codex/terminals" && req.method === "POST") {
      const body = await readBody(req);
      const workspace = resolveWorkspaceById(body?.workspaceId);
      if (!workspace) { sendError(res, 400, "workspaceId is not registered"); return true; }
      const active = [...sessions.values()].filter((session) => session.status === "running").length;
      if (active >= maxSessions) { sendError(res, 409, "too many active terminal sessions"); return true; }
      const session = await start(workspace, body || {});
      sendJson(res, 201, { terminal: publicTerminal(session) });
      return true;
    }

    const match = url.pathname.match(/^\/v1\/codex\/terminals\/([A-Za-z0-9-]+)(?:\/(stream|input|resize|close))?$/);
    if (!match) return false;
    const session = sessions.get(match[1]);
    if (!session) { sendError(res, 404, "terminal not found"); return true; }
    const action = match[2] || "detail";
    if (action === "detail" && req.method === "GET") {
      sendJson(res, 200, { terminal: publicTerminal(session) });
      return true;
    }
    if (action === "stream" && req.method === "GET") {
      stream(req, res, session);
      return true;
    }
    if (action === "input" && req.method === "POST") {
      if (session.status !== "running") { sendError(res, 409, "terminal is not running"); return true; }
      const body = await readBody(req);
      let bytes;
      if (typeof body?.dataBase64 === "string") bytes = Buffer.from(body.dataBase64, "base64");
      else if (typeof body?.text === "string") bytes = Buffer.from(body.text, "utf8");
      else { sendError(res, 400, "text or dataBase64 is required"); return true; }
      if (bytes.length > 64 * 1024) { sendError(res, 413, "terminal input is too large"); return true; }
      await session.client.request("command/exec/write", { processId: session.processId, deltaBase64: bytes.toString("base64") });
      sendJson(res, 202, { ok: true });
      return true;
    }
    if (action === "resize" && req.method === "POST") {
      if (session.status !== "running") { sendError(res, 409, "terminal is not running"); return true; }
      const body = await readBody(req);
      const size = cleanSize(body);
      await session.client.request("command/exec/resize", { processId: session.processId, size });
      session.cols = size.cols;
      session.rows = size.rows;
      sendJson(res, 200, { terminal: publicTerminal(session) });
      return true;
    }
    if (action === "close" && req.method === "POST") {
      await close(session);
      sendJson(res, 200, { terminal: publicTerminal(session) });
      return true;
    }
    sendError(res, 405, "method not allowed");
    return true;
  }

  async function start(workspace, body) {
    prune();
    const id = crypto.randomUUID();
    const processId = `relay-terminal-${id}`;
    const size = cleanSize(body);
    const createdAt = new Date().toISOString();
    const env = {
      ...process.env,
      HOME: runHome,
      CODEX_HOME: codexHome,
      TERM: "xterm-256color",
    };
    const client = new AppServerClient({ codexBin, cwd: workspace.path, env, experimental: true });
    const session = {
      id,
      processId,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      workspacePath: workspace.path,
      status: "starting",
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
      exitCode: null,
      cols: size.cols,
      rows: size.rows,
      output: "",
      sequence: 0,
      events: [],
      subscribers: new Set(),
      client,
    };
    sessions.set(id, session);
    client.on("stderr", (line) => appendOutput(session, `${line}\n`));
    client.on("notification", (message) => {
      if (message.method !== "command/exec/outputDelta") return;
      const params = message.params || {};
      if (params.processId !== processId || typeof params.deltaBase64 !== "string") return;
      appendOutput(session, Buffer.from(params.deltaBase64, "base64").toString("utf8"));
    });
    client.on("closed", (error) => {
      if (session.status === "closed") return;
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
      session.finishedAt = session.updatedAt;
      appendOutput(session, `\n[Relay terminal disconnected: ${error.message}]\n`);
      finishSubscribers(session);
    });
    await client.start();
    session.status = "running";
    session.updatedAt = new Date().toISOString();
    appendAudit("terminal_started", null, { id, workspaceId: workspace.id });
    const shell = terminalShell();
    void client.request("command/exec", {
      command: terminalCommand(shell),
      cwd: workspace.path,
      processId,
      tty: true,
      streamStdin: true,
      streamStdoutStderr: true,
      disableTimeout: true,
      size,
      permissionProfile: ":workspace",
    }, { timeoutMs: 0 }).then((result) => {
      session.status = "closed";
      session.exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : null;
      session.updatedAt = new Date().toISOString();
      session.finishedAt = session.updatedAt;
      finishSubscribers(session);
      client.stop();
      appendAudit("terminal_finished", null, { id, workspaceId: workspace.id, exitCode: session.exitCode });
    }).catch((error) => {
      if (session.status === "closed") return;
      session.status = "failed";
      session.updatedAt = new Date().toISOString();
      session.finishedAt = session.updatedAt;
      appendOutput(session, `\n[Terminal failed: ${error.message}]\n`);
      finishSubscribers(session);
      client.stop();
    });
    return session;
  }

  async function close(session) {
    if (session.status === "closed" || session.status === "failed") return;
    try { await session.client.request("command/exec/terminate", { processId: session.processId }); } catch {}
    session.status = "closed";
    session.updatedAt = new Date().toISOString();
    session.finishedAt = session.updatedAt;
    finishSubscribers(session);
    session.client.stop();
  }

  function appendOutput(session, raw) {
    const text = cleanTerminalText(raw);
    if (!text) return;
    session.output = `${session.output}${text}`;
    if (Buffer.byteLength(session.output, "utf8") > maxOutputBytes) {
      session.output = Buffer.from(session.output, "utf8").subarray(-maxOutputBytes).toString("utf8");
    }
    session.sequence += 1;
    session.updatedAt = new Date().toISOString();
    const event = { sequence: session.sequence, text };
    session.events.push(event);
    if (session.events.length > 1000) session.events.splice(0, session.events.length - 1000);
    for (const subscriber of [...session.subscribers]) writeSse(subscriber, "output", event, event.sequence);
  }

  function stream(req, res, session) {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const subscriber = { res, closed: false, heartbeat: null };
    writeSse(subscriber, "snapshot", { terminal: publicTerminal(session), output: session.output }, session.sequence);
    if (session.status !== "running" && session.status !== "starting") {
      writeSse(subscriber, "done", { terminal: publicTerminal(session) }, session.sequence);
      res.end();
      return;
    }
    session.subscribers.add(subscriber);
    subscriber.heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { removeSubscriber(session, subscriber); }
    }, 15000);
    subscriber.heartbeat.unref();
    req.on("close", () => removeSubscriber(session, subscriber));
  }

  function finishSubscribers(session) {
    for (const subscriber of [...session.subscribers]) {
      writeSse(subscriber, "done", { terminal: publicTerminal(session) }, session.sequence);
      removeSubscriber(session, subscriber, true);
    }
  }

  function removeSubscriber(session, subscriber, end = false) {
    if (subscriber.closed) return;
    subscriber.closed = true;
    clearInterval(subscriber.heartbeat);
    session.subscribers.delete(subscriber);
    if (end) { try { subscriber.res.end(); } catch {} }
  }

  function writeSse(subscriber, event, data, id) {
    if (subscriber.closed) return;
    try { subscriber.res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }
    catch { subscriber.closed = true; }
  }

  function prune() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, session] of sessions) {
      if ((session.status === "closed" || session.status === "failed") && Date.parse(session.finishedAt || 0) < cutoff) sessions.delete(id);
    }
  }

  return { route, sessions, start, close };
}

function cleanSize(body) {
  const cols = Number(body?.cols ?? body?.size?.cols ?? 80);
  const rows = Number(body?.rows ?? body?.size?.rows ?? 24);
  return {
    cols: Number.isInteger(cols) ? Math.min(Math.max(cols, 20), 300) : 80,
    rows: Number.isInteger(rows) ? Math.min(Math.max(rows, 8), 120) : 24,
  };
}

function terminalShell() {
  const configured = process.env.RELAY_TERMINAL_SHELL?.trim();
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return configured;
  if (fs.existsSync("/bin/zsh")) return "/bin/zsh";
  return "/bin/bash";
}

function terminalCommand(shell) {
  // Do not source the runner's interactive profile in a phone terminal. That
  // profile can contain unrelated aliases or secret-exporting startup hooks.
  if (path.basename(shell) === "zsh") return [shell, "-f", "-i"];
  if (path.basename(shell) === "bash") return [shell, "--noprofile", "--norc", "-i"];
  return [shell];
}

function cleanTerminalText(value) {
  return String(value || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r(?!\n)/g, "\n")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "");
}

function publicTerminal(session) {
  return {
    id: session.id,
    workspaceId: session.workspaceId,
    workspaceName: session.workspaceName,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    finishedAt: session.finishedAt,
    exitCode: session.exitCode,
    cols: session.cols,
    rows: session.rows,
  };
}

export { createTerminalService, cleanSize, cleanTerminalText, publicTerminal, terminalCommand };
