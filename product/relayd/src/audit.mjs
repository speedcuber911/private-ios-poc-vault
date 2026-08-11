// relayd audit.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { auditPath } from "./config.mjs";
import { nowIso } from "./util.mjs";

function appendAudit(event, job, extra = {}) {
  const line = JSON.stringify({
    ts: nowIso(),
    event,
    jobId: job?.id || null,
    status: job?.status || null,
    workspaceId: job?.workspaceId || null,
    certSubject: job?.certSubject || null,
    ...extra,
  });
  try {
    fs.appendFileSync(auditPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error(`failed to append audit log: ${error.message}`);
  }
}


export {
  appendAudit,
};
