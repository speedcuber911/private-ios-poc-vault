import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { directApiRequest, readDirectConfig, writeDirectConfig } from "../direct.mjs";
import { findGitRoot } from "../repo.mjs";
import { discoverSessions } from "../sessions.mjs";

const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_INLINE_SESSION_BYTES = 20 * 1024 * 1024;
const HASH_CHUNK_BYTES = 256 * 1024;

function flagValue(args, name) {
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] || null;
}

function validateArgs(args) {
  const consuming = new Set(["--workspace"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list-workspaces") continue;
    if (consuming.has(arg)) {
      if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${arg} requires a value`);
      index += 1;
      continue;
    }
    if ([...consuming].some((name) => arg.startsWith(`${name}=`))) continue;
    throw new Error(`unknown_option: ${arg}`);
  }
}

function sha256File(filePath) {
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
  try {
    for (;;) {
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      hash.update(chunk.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function normalizedName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function chooseWorkspace(workspaces, { root, explicit, mapped }) {
  const byId = new Map(workspaces.map((entry) => [entry.id, entry]));
  const mappedId = typeof mapped === "string" ? mapped : mapped?.id;
  if (explicit) {
    if (byId.has(explicit)) return byId.get(explicit);
    if (mappedId === explicit) return {
      id: mappedId,
      name: typeof mapped === "object" ? mapped.name || mappedId : mappedId,
      path: typeof mapped === "object" ? mapped.path || null : null,
      dynamic: true,
    };
    throw new Error(`unknown_workspace: ${explicit}`);
  }
  // Dynamic workspaces are materialized in relayd memory and disappear from
  // the GET list after a daemon restart, but resolveWorkspaceById can recover
  // their deterministic `dir-*` id by scanning the workspace root. A mapping
  // that was already selected successfully is therefore still authoritative.
  if (mapped) {
    if (mappedId) return byId.get(mappedId) || {
      id: mappedId,
      name: typeof mapped === "object" ? mapped.name || mappedId : mappedId,
      path: typeof mapped === "object" ? mapped.path || null : null,
      dynamic: true,
    };
  }
  if (workspaces.length === 1) return workspaces[0];

  const local = normalizedName(path.basename(root));
  const ranked = workspaces.map((workspace) => {
    const candidates = [workspace.id, workspace.name, path.basename(workspace.path || "")].map(normalizedName);
    const score = Math.max(...candidates.map((candidate) => {
      if (!candidate) return 0;
      if (candidate === local) return 100;
      if (local.includes(candidate) || candidate.includes(local)) return 60 + Math.min(candidate.length, local.length);
      return 0;
    }));
    return { workspace, score };
  }).sort((left, right) => right.score - left.score);
  if (ranked[0]?.score > 0 && ranked[0].score > (ranked[1]?.score || 0)) return ranked[0].workspace;
  throw new Error(`workspace_required: choose one with --workspace (${workspaces.map((entry) => entry.id).join(", ")})`);
}

async function cmdSyncSessions(args = [], deps = {}) {
  validateArgs(args);
  const {
    home = os.homedir(), cwd = process.cwd(), log = console.log,
    findGitRootImpl = findGitRoot,
    discoverSessionsImpl = discoverSessions,
    apiRequest = directApiRequest,
  } = deps;
  const config = readDirectConfig({ home });
  if (!config) {
    throw new Error("direct_not_connected: run `relayd pair --no-qr` on the Relay machine, then `relay connect '<Link>'` here once");
  }

  const workspaceResponse = await apiRequest(config, "/v1/codex/workspaces");
  if (workspaceResponse.status !== 200 || !Array.isArray(workspaceResponse.json?.workspaces)) {
    throw new Error(`direct_workspaces_failed_${workspaceResponse.status || "network"}`);
  }
  const workspaces = workspaceResponse.json.workspaces;
  if (args.includes("--list-workspaces")) {
    for (const workspace of workspaces) log(`  ${workspace.id.padEnd(20)} ${workspace.name}  ${workspace.path}`);
    return { workspaces };
  }

  const root = await findGitRootImpl({ cwd });
  const explicit = flagValue(args, "--workspace");
  const workspace = chooseWorkspace(workspaces, {
    root,
    explicit,
    mapped: config.workspaceMappings?.[root] || null,
  });
  const mappedWorkspace = config.workspaceMappings?.[root];
  if (
    (typeof mappedWorkspace === "string" ? mappedWorkspace : mappedWorkspace?.id) !== workspace.id ||
    (workspace.path && (typeof mappedWorkspace !== "object" || mappedWorkspace.path !== workspace.path))
  ) {
    writeDirectConfig({
      workspaceMappings: {
        ...(config.workspaceMappings || {}),
        [root]: { id: workspace.id, name: workspace.name, path: workspace.path || null },
      },
    }, { home });
  }

  const discovered = discoverSessionsImpl({ cwd: root, home })
    .filter((session) => session.harness === "codex");
  const skipped = [];
  const eligible = [];
  for (const session of discovered) {
    if (session.sizeBytes > MAX_SESSION_BYTES) {
      skipped.push({ id: session.id, reason: "larger_than_256_mb" });
      continue;
    }
    try {
      eligible.push({
        session,
        descriptor: {
          id: session.id,
          sha256: sha256File(session.filePath),
          sizeBytes: session.sizeBytes,
          updatedAt: session.lastActive,
          createdAt: session.createdAt || null,
        },
      });
    } catch {
      skipped.push({ id: session.id, reason: "unreadable" });
    }
  }

  const planResponse = await apiRequest(config, "/v1/codex/session-imports/plan", {
    method: "POST",
    body: {
      v: 1,
      workspaceId: workspace.id,
      workspacePath: workspace.path || (typeof mappedWorkspace === "object" ? mappedWorkspace.path || null : null),
      sessions: eligible.map((entry) => entry.descriptor),
    },
  });
  if (planResponse.status !== 200 || !Array.isArray(planResponse.json?.sessions)) {
    throw new Error(`session_sync_plan_failed_${planResponse.status}: ${planResponse.json?.error || "invalid response"}`);
  }
  const plan = new Map(planResponse.json.sessions.map((entry) => [entry.id, entry]));
  let imported = 0;
  let current = 0;
  let conflicts = 0;

  for (const entry of eligible) {
    const action = plan.get(entry.session.id);
    if (action?.status === "current") {
      current += 1;
      continue;
    }
    if (action?.status === "conflict") {
      conflicts += 1;
      skipped.push({ id: entry.session.id, reason: "changed_on_relay_machine" });
      continue;
    }
    const currentSize = fs.statSync(entry.session.filePath).size;
    if (currentSize > MAX_SESSION_BYTES) {
      skipped.push({ id: entry.session.id, reason: "grew_larger_than_256_mb" });
      continue;
    }
    let upload;
    if (currentSize <= MAX_INLINE_SESSION_BYTES) {
      const transcript = fs.readFileSync(entry.session.filePath);
      const sourceSha256 = crypto.createHash("sha256").update(transcript).digest("hex");
      upload = await apiRequest(config, "/v1/codex/session-imports", {
        method: "POST",
        body: {
          v: 1,
          workspaceId: workspace.id,
          workspacePath: workspace.path || (typeof mappedWorkspace === "object" ? mappedWorkspace.path || null : null),
          sourceCwd: entry.session.sourceCwd || root,
          session: {
            id: entry.session.id,
            createdAt: entry.session.createdAt || entry.session.lastActive,
            updatedAt: entry.session.lastActive,
            sha256: sourceSha256,
            transcript: transcript.toString("base64"),
          },
        },
      });
    } else {
      const started = await apiRequest(config, "/v1/codex/session-imports/uploads", {
        method: "POST",
        body: {
          v: 1,
          workspaceId: workspace.id,
          workspacePath: workspace.path || (typeof mappedWorkspace === "object" ? mappedWorkspace.path || null : null),
          sourceCwd: entry.session.sourceCwd || root,
          session: { ...entry.descriptor, sizeBytes: currentSize },
        },
      });
      if (started.status === 200 && started.json?.status === "current") {
        current += 1;
        continue;
      }
      if (started.status !== 201 || !started.json?.uploadId) {
        if (started.status === 409) {
          conflicts += 1;
          skipped.push({ id: entry.session.id, reason: started.json?.error || "changed_on_relay_machine" });
          continue;
        }
        throw new Error(`session_sync_upload_start_failed_${started.status}: ${started.json?.error || entry.session.id}`);
      }
      const chunkBytes = Number.isSafeInteger(started.json.chunkBytes) ? started.json.chunkBytes : 4 * 1024 * 1024;
      const fd = fs.openSync(entry.session.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      let offset = 0;
      try {
        const buffer = Buffer.alloc(chunkBytes);
        for (;;) {
          const count = fs.readSync(fd, buffer, 0, buffer.length, null);
          if (count === 0) break;
          const chunk = await apiRequest(config, `/v1/codex/session-imports/uploads/${started.json.uploadId}/chunks`, {
            method: "POST",
            body: { offset, data: buffer.subarray(0, count).toString("base64") },
          });
          if (chunk.status !== 200) {
            throw new Error(`session_sync_chunk_failed_${chunk.status}: ${chunk.json?.error || entry.session.id}`);
          }
          offset += count;
        }
      } finally {
        fs.closeSync(fd);
      }
      upload = await apiRequest(config, `/v1/codex/session-imports/uploads/${started.json.uploadId}/complete`, {
        method: "POST", body: {},
      });
    }
    if (upload.status === 409) {
      conflicts += 1;
      skipped.push({ id: entry.session.id, reason: upload.json?.error || "changed_on_relay_machine" });
      continue;
    }
    if (upload.status !== 200 && upload.status !== 201) {
      throw new Error(`session_sync_upload_failed_${upload.status}: ${upload.json?.error || entry.session.id}`);
    }
    if (upload.json?.status === "current") current += 1;
    else imported += 1;
  }

  log(`  Repository: ${root}`);
  log(`  Workspace:  ${workspace.name} (${workspace.id})`);
  log(`  Sessions:   ${imported} imported, ${current} current, ${conflicts} conflict${conflicts === 1 ? "" : "s"}`);
  for (const item of skipped) log(`  Skipped:    ${item.id} (${item.reason})`);
  if (conflicts > 0) {
    log("");
    log("  Conflicting sessions were left untouched because they have newer work on the Relay machine.");
  }
  return { root, workspace, imported, current, conflicts, skipped };
}

export { MAX_SESSION_BYTES, MAX_INLINE_SESSION_BYTES, chooseWorkspace, sha256File, cmdSyncSessions };
