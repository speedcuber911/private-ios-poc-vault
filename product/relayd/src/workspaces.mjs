// relayd workspaces.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { workspaceBrowseRoot, maxWorkspaceDirEntries, cleanDisplayName, realpathOrResolve } from "./config.mjs";

const dynamicWorkspaces = new Map();

const workspaces = loadWorkspaces();

function loadWorkspaces() {
  const configured = process.env.CODEX_WORKSPACES
    ? JSON.parse(process.env.CODEX_WORKSPACES)
    : [
        { id: "scratch", name: "Scratch", path: "/srv/codex-workspaces/scratch" },
        { id: "poc-vault", name: "POC Vault", path: "/srv/codex-workspaces/poc-vault" },
        { id: "sigiq", name: "SigiQ", path: "/srv/codex-workspaces/sigiq" },
      ];

  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error("CODEX_WORKSPACES must be a non-empty JSON array");
  }

  const registry = new Map();
  for (const entry of configured) {
    if (!entry || typeof entry !== "object") {
      throw new Error("CODEX_WORKSPACES entries must be objects");
    }

    const id = cleanWorkspaceId(entry.id);
    const name = cleanDisplayName(entry.name || entry.id, "workspace name", 120);
    const workspacePath = cleanWorkspacePath(entry.path, id);

    if (registry.has(id)) {
      throw new Error(`duplicate workspace id: ${id}`);
    }

    fs.mkdirSync(workspacePath, { recursive: true });
    registry.set(id, {
      id,
      name,
      path: fs.realpathSync(workspacePath),
    });
  }

  return registry;
}


function workspaceList() {
  const byId = new Map(workspaces);
  for (const workspace of dynamicWorkspaces.values()) {
    byId.set(workspace.id, workspace);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}


function resolveWorkspaceById(id) {
  return workspaces.get(id) || dynamicWorkspaces.get(id) || findDynamicWorkspaceById(id);
}


function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
  };
}


function browseWorkspaceForPath(workspacePath, { materialize = false } = {}) {
  const resolvedPath = realpathOrResolve(workspacePath);
  const exactRegistered = [...workspaces.values()].find((workspace) => workspace.path === resolvedPath);
  if (exactRegistered) return exactRegistered;
  const exactDynamic = [...dynamicWorkspaces.values()].find((workspace) => workspace.path === resolvedPath);
  if (exactDynamic) return exactDynamic;

  if (!pathBelongsToRoot(resolvedPath, workspaceBrowseRoot) || resolvedPath === workspaceBrowseRoot) {
    return null;
  }

  const relativePath = path.relative(workspaceBrowseRoot, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;

  const workspace = {
    id: dynamicWorkspaceId(relativePath),
    name: dynamicWorkspaceName(relativePath),
    path: resolvedPath,
    dynamic: true,
  };

  const existingById = workspaces.get(workspace.id) || dynamicWorkspaces.get(workspace.id);
  if (existingById) {
    if (existingById.path === workspace.path) return existingById;
    workspace.id = `${workspace.id}-${shortHash(relativePath)}`;
  }

  if (materialize) {
    dynamicWorkspaces.set(workspace.id, workspace);
  }
  return workspace;
}


function findDynamicWorkspaceById(id) {
  if (typeof id !== "string" || !id.startsWith("dir-")) return null;
  const stack = [workspaceBrowseRoot];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const current = stack.pop();
    visited += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = safeRealDirectory(path.join(current, entry.name));
      if (!entryPath || !pathBelongsToRoot(entryPath, workspaceBrowseRoot)) continue;
      const workspace = browseWorkspaceForPath(entryPath);
      if (workspace?.id === id) {
        dynamicWorkspaces.set(workspace.id, workspace);
        return workspace;
      }
      stack.push(entryPath);
    }
  }
  return null;
}


function dynamicWorkspaceId(relativePath) {
  const slug = relativePath
    .split(path.sep)
    .filter(Boolean)
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/--+/g, "-"),
    )
    .filter(Boolean)
    .join("-");
  return `dir-${slug || "workspace"}`.slice(0, 80);
}


function dynamicWorkspaceName(relativePath) {
  const segments = relativePath.split(path.sep).filter(Boolean);
  const first = segments[0];
  const firstPath = first ? path.join(workspaceBrowseRoot, first) : null;
  const firstWorkspace = firstPath ? [...workspaces.values()].find((workspace) => workspace.path === realpathOrResolve(firstPath)) : null;
  const displaySegments = segments.map((segment, index) => (index === 0 && firstWorkspace ? firstWorkspace.name : segment));
  return displaySegments.join(" / ");
}


function shortHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}


function cleanWorkspaceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new Error("workspace id must be 1-80 characters of letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}


function cleanWorkspacePath(value, id) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`workspace ${id} path is invalid`);
  }
  return path.resolve(value);
}


function workspaceDirectoryResponse({ requestedPath = "", query = "" } = {}) {
  const currentPath = resolveBrowseDirectory(requestedPath || "");
  const relativePath = relativeBrowsePath(currentPath);
  const search = typeof query === "string" ? query.trim().toLowerCase() : "";
  const entries = workspaceDirectoryEntries(currentPath, search);
  const parent = currentPath === workspaceBrowseRoot ? null : path.dirname(currentPath);
  const selectedWorkspace = currentPath === workspaceBrowseRoot ? null : browseWorkspaceForPath(currentPath);

  return {
    rootPath: workspaceBrowseRoot,
    currentPath,
    relativePath,
    parentPath: parent && pathBelongsToRoot(parent, workspaceBrowseRoot) ? parent : null,
    selectedWorkspace: selectedWorkspace ? publicWorkspace(selectedWorkspace) : null,
    entries,
  };
}


function workspaceDirectoryEntries(currentPath, search) {
  const results = [];
  const stack = [{ dir: currentPath, depth: 0 }];
  const pathSearch = search.includes("/") || search.includes("\\");
  const normalizedPathSearch = search.replaceAll("\\", "/");
  const maps = browseWorkspaceMaps();

  while (stack.length > 0 && results.length < maxWorkspaceDirEntries) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const dirent of entries) {
      if (dirent.name.startsWith(".")) continue;
      const entryPath = resolveListedDirectory(dir, dirent);
      if (!entryPath) continue;
      const relativePath = relativeBrowsePath(entryPath);
      const matches =
        !search ||
        dirent.name.toLowerCase().includes(search) ||
        (pathSearch && relativePath.toLowerCase().includes(normalizedPathSearch));
      if (matches) {
        const workspace = describeBrowseWorkspace(entryPath, maps);
        results.push({
          name: dirent.name,
          path: entryPath,
          relativePath,
          workspaceId: workspace?.id || null,
          workspaceName: workspace?.name || null,
          hasGit: fs.existsSync(path.join(entryPath, ".git")),
          isRegistered: Boolean(workspace && workspaces.get(workspace.id)),
        });
        if (results.length >= maxWorkspaceDirEntries) break;
      }
      if (search && depth < 8) stack.push({ dir: entryPath, depth: depth + 1 });
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

// Resolves a listed dirent to a real directory path without a per-entry realpath.
// Parent paths handed to listings are already fully resolved, so a plain directory
// entry needs no further resolution; only symlinks are realpathed and contained.

function resolveListedDirectory(parentPath, dirent) {
  const candidate = path.join(parentPath, dirent.name);
  if (dirent.isDirectory()) return candidate;
  if (!dirent.isSymbolicLink()) return null;
  const resolved = safeRealDirectory(candidate);
  if (!resolved || !resolvedPathWithinRoot(resolved)) return null;
  return resolved;
}

// Prebuilt path -> workspace and id -> workspace lookup maps so listings avoid a
// linear registry scan per entry. Registered workspaces take precedence over
// dynamic ones, matching resolveWorkspaceById/browseWorkspaceForPath ordering.

function browseWorkspaceMaps() {
  const byPath = new Map();
  const byId = new Map();
  for (const workspace of workspaces.values()) {
    byPath.set(workspace.path, workspace);
    byId.set(workspace.id, workspace);
  }
  for (const workspace of dynamicWorkspaces.values()) {
    if (!byPath.has(workspace.path)) byPath.set(workspace.path, workspace);
    if (!byId.has(workspace.id)) byId.set(workspace.id, workspace);
  }
  return { byPath, byId };
}

// Map-backed equivalent of browseWorkspaceForPath for already-resolved paths.
// Never materializes dynamic workspaces; listing must not mutate the registry.

function describeBrowseWorkspace(resolvedPath, maps) {
  const exact = maps.byPath.get(resolvedPath);
  if (exact) return exact;

  if (!resolvedPathWithinRoot(resolvedPath) || resolvedPath === workspaceBrowseRoot) {
    return null;
  }

  const relativePath = path.relative(workspaceBrowseRoot, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;

  const workspace = {
    id: dynamicWorkspaceId(relativePath),
    name: dynamicWorkspaceName(relativePath),
    path: resolvedPath,
    dynamic: true,
  };
  const existingById = maps.byId.get(workspace.id);
  if (existingById) {
    if (existingById.path === workspace.path) return existingById;
    workspace.id = `${workspace.id}-${shortHash(relativePath)}`;
  }
  return workspace;
}

// Compiles one CODEX_FS_READ_DENYLIST pattern. Only `*` is a wildcard; every
// other character matches literally and matching is case-insensitive on the
// entry basename.

function selectWorkspaceDirectory(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const selectedPath = resolveBrowseDirectory(body.path || "");
  if (selectedPath === workspaceBrowseRoot) {
    throw Object.assign(new Error("workspace root cannot be selected"), { status: 400 });
  }
  const workspace = browseWorkspaceForPath(selectedPath, { materialize: true });
  if (!workspace) {
    throw Object.assign(new Error("selected path is not inside the workspace root"), { status: 400 });
  }
  return workspace;
}


function createWorkspaceDirectory(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }

  const parentPath = resolveBrowseDirectory(body.parentPath || body.path || "");
  const name = cleanWorkspaceDirectoryName(body.name);
  const targetPath = path.resolve(parentPath, name);
  if (!pathBelongsToRoot(targetPath, workspaceBrowseRoot) || targetPath === workspaceBrowseRoot) {
    throw Object.assign(new Error("workspace path must stay inside the workspace root"), { status: 400 });
  }

  try {
    fs.mkdirSync(targetPath, { recursive: false, mode: 0o755 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw Object.assign(new Error("workspace folder already exists"), { status: 409 });
    }
    throw error;
  }

  const workspacePath = safeRealDirectory(targetPath);
  if (!workspacePath) {
    throw Object.assign(new Error("workspace folder could not be created"), { status: 500 });
  }
  return browseWorkspaceForPath(workspacePath, { materialize: true });
}


function cleanWorkspaceDirectoryName(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("workspace folder name is invalid"), { status: 400 });
  }
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > 80 ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    /[\/\\\0\r\n]/.test(name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)
  ) {
    throw Object.assign(new Error("workspace folder name is invalid"), { status: 400 });
  }
  return name;
}


function resolveBrowseDirectory(value) {
  return resolveBrowsePath(value, { kind: "dir" }).path;
}

// Kind-aware jail resolver shared by the directory browser and the read-only
// files API. Every returned path is realpath-resolved and contained inside
// workspaceBrowseRoot.
//
// - kind "dir" keeps the legacy workspace-dirs contract: missing or
//   non-directory paths return 404 before the containment check runs.
// - kind "file" rejects escapes first (including lexical `..`/absolute escapes,
//   without disclosing whether the outside path exists), then requires a
//   regular file.

function resolveBrowsePath(value, { kind = "dir" } = {}) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
    throw Object.assign(new Error("workspace path is invalid"), { status: 400 });
  }
  const trimmed = value.trim();
  const candidate = trimmed
    ? path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(workspaceBrowseRoot, trimmed))
    : workspaceBrowseRoot;

  let resolved = null;
  let stat = null;
  try {
    resolved = fs.realpathSync(candidate);
    stat = fs.statSync(resolved);
  } catch {
    resolved = null;
    stat = null;
  }

  if (kind === "file") {
    if (resolved && !resolvedPathWithinRoot(resolved)) {
      throw Object.assign(new Error("path must stay inside the workspace root"), { status: 400 });
    }
    if (!resolved || !stat) {
      // A missing path that is lexically outside the root gets the same escape
      // error so probing cannot distinguish existing outside files.
      if (!resolvedPathWithinRoot(candidate)) {
        throw Object.assign(new Error("path must stay inside the workspace root"), { status: 400 });
      }
      throw Object.assign(new Error("file was not found"), { status: 404 });
    }
    if (!stat.isFile()) {
      throw Object.assign(new Error("path is not a regular file"), { status: 400 });
    }
    return { path: resolved, stat };
  }

  if (!resolved || !stat || !stat.isDirectory()) {
    throw Object.assign(new Error("workspace directory was not found"), { status: 404 });
  }
  if (!resolvedPathWithinRoot(resolved)) {
    throw Object.assign(new Error("workspace path must stay inside the workspace root"), { status: 400 });
  }
  return { path: resolved, stat };
}

// Fast containment check for candidates that are already realpath-resolved.
// workspaceBrowseRoot itself is resolved once at boot, so no repeated root
// realpath is needed on hot listing paths.

function resolvedPathWithinRoot(resolvedPath) {
  return resolvedPath === workspaceBrowseRoot || resolvedPath.startsWith(`${workspaceBrowseRoot}${path.sep}`);
}


function safeRealDirectory(candidate) {
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}


function relativeBrowsePath(value) {
  const relativePath = path.relative(workspaceBrowseRoot, value);
  return relativePath ? relativePath.split(path.sep).join("/") : "";
}


function pathBelongsToRoot(candidate, root) {
  const resolvedCandidate = realpathOrResolve(candidate);
  const resolvedRoot = realpathOrResolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}


export {
  dynamicWorkspaces,
  workspaces,
  loadWorkspaces,
  workspaceList,
  resolveWorkspaceById,
  publicWorkspace,
  browseWorkspaceForPath,
  findDynamicWorkspaceById,
  dynamicWorkspaceId,
  dynamicWorkspaceName,
  shortHash,
  cleanWorkspaceId,
  cleanWorkspacePath,
  workspaceDirectoryResponse,
  workspaceDirectoryEntries,
  resolveListedDirectory,
  browseWorkspaceMaps,
  describeBrowseWorkspace,
  selectWorkspaceDirectory,
  createWorkspaceDirectory,
  cleanWorkspaceDirectoryName,
  resolveBrowseDirectory,
  resolveBrowsePath,
  resolvedPathWithinRoot,
  safeRealDirectory,
  relativeBrowsePath,
  pathBelongsToRoot,
};
