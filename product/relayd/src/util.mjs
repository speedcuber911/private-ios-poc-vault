// relayd util.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { maxBodyBytes } from "./config.mjs";
import { isResumableSessionId } from "./sessionid.mjs";

function nowIso() {
  return new Date().toISOString();
}


function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}


function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}


function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}


function sendBytes(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": body.length,
    ...headers,
  });
  res.end(body);
}


function sendError(res, status, message) {
  return sendJson(res, status, { error: message });
}


function initSse(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
}


function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });

    req.on("error", reject);
  });
}


function readBinaryBody(req, byteLimit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > byteLimit) {
        reject(Object.assign(new Error("audio body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length === 0) {
        reject(Object.assign(new Error("audio body is required"), { status: 400 }));
        return;
      }
      resolve(body);
    });

    req.on("error", reject);
  });
}


function headerValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}


function clampLimit(value) {
  const parsed = Number(value || "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}


// Job ids are `crypto.randomUUID()`s and resumable SESSION ids have exactly
// the same shape, so there is one predicate for both and it lives in
// sessionid.mjs — see the long note there for why the two used to disagree and
// what that cost. The regex is no longer written out here: a second copy of it
// is precisely the drift this consolidation removes.
function isSafeJobId(id) {
  return isResumableSessionId(id);
}


async function shapeTextPayload({ file, value, byteLimit, includeFull, trim = false, slice = "prefix" }) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 0 || !value) {
      return await shapeTextFile(file, stat.size, byteLimit, includeFull, trim, slice);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return shapeTextValue(value, byteLimit, includeFull, trim, slice);
}


async function shapeTextFile(file, byteCount, byteLimit, includeFull, trim, slice) {
  const raw = includeFull ? await fsp.readFile(file, "utf8") : await readTextFileSlice(file, byteCount, byteLimit, slice);
  const text = cleanPayloadText(raw, trim);
  const preview = includeFull ? cleanPayloadText(sliceByBytes(raw, byteLimit, slice), trim) : text;
  return {
    text,
    preview,
    bytes: byteCount,
    truncated: !includeFull && byteCount > byteLimit,
  };
}


function shapeTextValue(value, byteLimit, includeFull, trim, slice) {
  const raw = value ? String(value) : "";
  const byteCount = Buffer.byteLength(raw, "utf8");
  const text = cleanPayloadText(includeFull ? raw : sliceByBytes(raw, byteLimit, slice), trim);
  return {
    text,
    preview: cleanPayloadText(sliceByBytes(raw, byteLimit, slice), trim),
    bytes: byteCount,
    truncated: !includeFull && byteCount > byteLimit,
  };
}


function cleanPayloadText(value, trim) {
  const text = cleanApiText(value);
  return trim ? text.trim() : text;
}


async function readTextFilePrefix(file, byteLimit) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}


async function readTextFileSuffix(file, byteCount, byteLimit) {
  const handle = await fsp.open(file, "r");
  try {
    const length = Math.min(byteCount, byteLimit);
    const offset = Math.max(0, byteCount - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}


async function readTextFileSlice(file, byteCount, byteLimit, slice) {
  if (slice === "suffix") {
    return readTextFileSuffix(file, byteCount, byteLimit);
  }
  return readTextFilePrefix(file, byteLimit);
}


function prefixByBytes(value, byteLimit) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(0, Math.min(buffer.length, byteLimit)).toString("utf8");
}


function suffixByBytes(value, byteLimit) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - byteLimit)).toString("utf8");
}


function sliceByBytes(value, byteLimit, slice) {
  if (slice === "suffix") {
    return suffixByBytes(value, byteLimit);
  }
  return prefixByBytes(value, byteLimit);
}


function cleanAssistantResult(value) {
  if (!value) return "";
  return cleanApiText(value).trim();
}


function cleanApiText(value) {
  if (!value) return "";
  return stripAnsi(String(value)).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}


function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}


async function readTextFileBounded(file, byteLimit) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size === 0) return "";

    const length = Math.min(stat.size, byteLimit);
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const suffix = stat.size > byteLimit ? "\n[output truncated]\n" : "";
      return `${buffer.toString("utf8")}${suffix}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}


export {
  nowIso,
  durationMs,
  sendJson,
  sendHtml,
  sendBytes,
  sendError,
  initSse,
  sendSse,
  readBody,
  readBinaryBody,
  headerValue,
  clampLimit,
  isSafeJobId,
  shapeTextPayload,
  shapeTextFile,
  shapeTextValue,
  cleanPayloadText,
  readTextFilePrefix,
  readTextFileSuffix,
  readTextFileSlice,
  prefixByBytes,
  suffixByBytes,
  sliceByBytes,
  cleanAssistantResult,
  cleanApiText,
  stripAnsi,
  readTextFileBounded,
};
