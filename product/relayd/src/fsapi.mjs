// relayd fsapi.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { workspaceBrowseRoot, maxFsListEntries, maxFsReadBytes, maxFsFileBytes, fsReadDenylist } from "./config.mjs";
import { headerValue } from "./util.mjs";
import { workspaces, publicWorkspace, browseWorkspaceMaps, describeBrowseWorkspace, resolveBrowsePath, resolvedPathWithinRoot, relativeBrowsePath } from "./workspaces.mjs";
import { contentDispositionFilename, artifactPreviewWrapper } from "./artifacts.mjs";

function isReadDeniedName(name) {
  return fsReadDenylist.some((pattern) => pattern.test(name));
}


const fsTextMimeByExtension = new Map([
  [".txt", "text/plain"],
  [".log", "text/plain"],
  [".text", "text/plain"],
  [".md", "text/markdown"],
  [".markdown", "text/markdown"],
  [".json", "application/json"],
  [".jsonl", "application/json"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".cjs", "text/javascript"],
  [".jsx", "text/javascript"],
  [".ts", "text/plain"],
  [".tsx", "text/plain"],
  [".css", "text/css"],
  [".html", "text/html"],
  [".htm", "text/html"],
  [".svg", "image/svg+xml"],
  [".xml", "application/xml"],
  [".yaml", "text/plain"],
  [".yml", "text/plain"],
  [".toml", "text/plain"],
  [".ini", "text/plain"],
  [".conf", "text/plain"],
  [".csv", "text/csv"],
  [".tsv", "text/plain"],
  [".sh", "text/plain"],
  [".bash", "text/plain"],
  [".zsh", "text/plain"],
  [".py", "text/plain"],
  [".rb", "text/plain"],
  [".go", "text/plain"],
  [".rs", "text/plain"],
  [".java", "text/plain"],
  [".kt", "text/plain"],
  [".swift", "text/plain"],
  [".c", "text/plain"],
  [".h", "text/plain"],
  [".cpp", "text/plain"],
  [".hpp", "text/plain"],
  [".m", "text/plain"],
  [".sql", "text/plain"],
  [".env", "text/plain"],
  [".plist", "text/plain"],
  [".lock", "text/plain"],
  [".mod", "text/plain"],
  [".sum", "text/plain"],
]);


const fsBinaryMimeByExtension = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".heic", "image/heic"],
  [".pdf", "application/pdf"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".xls", "application/vnd.ms-excel"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".doc", "application/msword"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".rtf", "application/rtf"],
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".tar", "application/x-tar"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);


const fsTextBasenames = new Set([
  ".gitignore",
  ".gitattributes",
  ".gitmodules",
  ".editorconfig",
  ".nvmrc",
  ".npmrc",
  ".netrc",
  ".env",
  "dockerfile",
  "makefile",
  "license",
  "readme",
  "changelog",
  "agents.md",
]);

// Conservative extension-based MIME hint. This never sniffs content; unknown
// extensions fall back to application/octet-stream and download disposition.

function mimeHintForFilename(name) {
  const lowerName = String(name || "").toLowerCase();
  const extension = path.extname(lowerName);
  if (extension && fsTextMimeByExtension.has(extension)) {
    const mime = fsTextMimeByExtension.get(extension);
    return { mime: `${mime}; charset=utf-8`, isText: true };
  }
  if (extension && fsBinaryMimeByExtension.has(extension)) {
    return { mime: fsBinaryMimeByExtension.get(extension), isText: false };
  }
  if (fsTextBasenames.has(lowerName) || lowerName.startsWith(".env")) {
    return { mime: "text/plain; charset=utf-8", isText: true };
  }
  return { mime: "application/octet-stream", isText: false };
}


function cleanFsListOffset(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error("offset must be a non-negative integer"), { status: 400 });
  }
  return parsed;
}


function cleanFsListLimit(value) {
  if (value === null || value === undefined || value === "") return maxFsListEntries;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw Object.assign(new Error("limit must be a positive integer"), { status: 400 });
  }
  return Math.min(parsed, maxFsListEntries);
}


function fsListResponse(searchParams) {
  const resolved = resolveBrowsePath(searchParams.get("path") || "", { kind: "dir" });
  const currentPath = resolved.path;
  const offset = cleanFsListOffset(searchParams.get("offset"));
  const limit = cleanFsListLimit(searchParams.get("limit"));
  const maps = browseWorkspaceMaps();
  const entries = collectFsEntries(currentPath, maps);
  const page = entries.slice(offset, offset + limit);
  const parent = currentPath === workspaceBrowseRoot ? null : path.dirname(currentPath);
  const workspace = currentPath === workspaceBrowseRoot ? null : describeBrowseWorkspace(currentPath, maps);

  return {
    rootPath: workspaceBrowseRoot,
    path: relativeBrowsePath(currentPath),
    absolutePath: currentPath,
    parentPath: parent && resolvedPathWithinRoot(parent) ? parent : null,
    workspace: workspace ? publicWorkspace(workspace) : null,
    offset,
    limit,
    total: entries.length,
    truncated: offset + page.length < entries.length,
    entries: page,
  };
}

// Lists one directory: directories first, then files, each sorted by name.
// Dotfiles are listed; secret-pattern files stay listed but carry
// readDenied: true so the client knows the HTTP read will be refused.

function collectFsEntries(currentPath, maps) {
  let dirents = [];
  try {
    dirents = fs.readdirSync(currentPath, { withFileTypes: true });
  } catch {
    throw Object.assign(new Error("directory could not be read"), { status: 500 });
  }

  const dirs = [];
  const files = [];
  for (const dirent of dirents) {
    const entry = fsEntryForDirent(currentPath, dirent, maps);
    if (!entry) continue;
    (entry.kind === "dir" ? dirs : files).push(entry);
  }
  const byName = (left, right) => left.name.localeCompare(right.name);
  return [...dirs.sort(byName), ...files.sort(byName)];
}


function fsEntryForDirent(parentPath, dirent, maps) {
  const candidate = path.join(parentPath, dirent.name);
  let resolved = candidate;
  let stat = null;
  if (dirent.isSymbolicLink()) {
    try {
      resolved = fs.realpathSync(candidate);
      stat = fs.statSync(resolved);
    } catch {
      return null;
    }
    if (!resolvedPathWithinRoot(resolved)) return null;
  } else if (dirent.isDirectory() || dirent.isFile()) {
    try {
      stat = fs.statSync(candidate);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const relativePath = relativeBrowsePath(resolved);
  const modifiedAt = stat.mtime.toISOString();
  if (stat.isDirectory()) {
    const workspace = describeBrowseWorkspace(resolved, maps);
    return {
      name: dirent.name,
      kind: "dir",
      path: relativePath,
      absolutePath: resolved,
      modifiedAt,
      workspaceId: workspace?.id || null,
      workspaceName: workspace?.name || null,
      hasGit: fs.existsSync(path.join(resolved, ".git")),
      isRegistered: Boolean(workspace && workspaces.get(workspace.id)),
    };
  }
  if (!stat.isFile()) return null;

  const hint = mimeHintForFilename(dirent.name);
  return {
    name: dirent.name,
    kind: "file",
    path: relativePath,
    absolutePath: resolved,
    size: stat.size,
    modifiedAt,
    mime: hint.mime,
    isText: hint.isText,
    readDenied: isReadDeniedName(dirent.name),
  };
}


function isTruthyQueryParam(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

// Single-range parser for `Range: bytes=<start>-<end>` requests. Returns null
// for malformed or unsatisfiable ranges (caller answers 416).

function parseByteRange(value, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(value).trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0 || size === 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start >= size) return null;
  if (match[2] === "") return { start, end: size - 1 };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

// GET|HEAD /v1/codex/fs/file — bounded read-only file access inside the jail.
// Guard order: jail containment, regular file, read denylist. Responses always
// carry no-store, nosniff, and a safe content disposition. Active content
// (HTML/SVG) downloads unless the sandboxed preview is explicitly requested.

function serveFsFile(req, res, searchParams) {
  const { path: filePath, stat } = resolveBrowsePath(searchParams.get("path") || "", { kind: "file" });
  const name = path.basename(filePath);
  if (isReadDeniedName(name)) {
    throw Object.assign(new Error("file matches the read denylist"), { status: 403 });
  }
  if (stat.size > maxFsFileBytes) {
    throw Object.assign(new Error("file exceeds the maximum readable size"), { status: 413 });
  }

  const hint = mimeHintForFilename(name);
  const isActiveContent = hint.mime.startsWith("text/html") || hint.mime.startsWith("image/svg");
  if (isTruthyQueryParam(searchParams.get("preview"))) {
    return serveFsFilePreview(req, res, { filePath, stat, name, isActiveContent });
  }

  let status = 200;
  let start = 0;
  let end = Math.min(stat.size, maxFsReadBytes) - 1;
  const rangeHeader = headerValue(req.headers.range);
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, stat.size);
    if (!range) {
      res.writeHead(416, {
        "content-range": `bytes */${stat.size}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end();
      return;
    }
    status = 206;
    start = range.start;
    end = Math.min(range.end, start + maxFsReadBytes - 1);
  } else if (stat.size > maxFsReadBytes) {
    // Larger permitted files stream in bounded windows: the first window is
    // served as 206 so the client knows to continue with Range requests.
    status = 206;
  }

  const length = Math.max(0, end - start + 1);
  const inlineSafe =
    !isActiveContent &&
    (hint.isText || ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(hint.mime));
  const disposition = isTruthyQueryParam(searchParams.get("download")) || !inlineSafe ? "attachment" : "inline";
  const headers = {
    "content-type": hint.mime,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "content-length": length,
    "content-disposition": `${disposition}; filename="${contentDispositionFilename(name)}"`,
  };
  if (status === 206) {
    headers["content-range"] = `bytes ${start}-${end}/${stat.size}`;
  }

  if (req.method === "HEAD") {
    res.writeHead(status, headers);
    res.end();
    return;
  }

  let body = Buffer.alloc(length);
  if (length > 0) {
    const fd = fs.openSync(filePath, "r");
    try {
      const bytesRead = fs.readSync(fd, body, 0, length, start);
      if (bytesRead < length) {
        body = body.subarray(0, bytesRead);
        headers["content-length"] = body.length;
        if (status === 206) headers["content-range"] = `bytes ${start}-${start + Math.max(0, body.length - 1)}/${stat.size}`;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  res.writeHead(status, headers);
  res.end(body);
}

// Explicit sandboxed preview for HTML/SVG using the same srcdoc + CSP wrapper
// as job artifact previews.

function serveFsFilePreview(req, res, { filePath, stat, name, isActiveContent }) {
  if (!isActiveContent) {
    throw Object.assign(new Error("preview is only available for HTML and SVG files"), { status: 400 });
  }
  if (stat.size > maxFsReadBytes) {
    throw Object.assign(new Error("file exceeds the preview size limit"), { status: 413 });
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const language = mimeHintForFilename(name).mime.startsWith("image/svg") ? "svg" : "html";
  const html = artifactPreviewWrapper({ filename: name, title: name, kind: "file preview", language }, raw);
  const body = Buffer.from(html, "utf8");
  const headers = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": body.length,
  };
  if (req.method === "HEAD") {
    res.writeHead(200, headers);
    res.end();
    return;
  }
  res.writeHead(200, headers);
  res.end(body);
}


// GET /v1/export.tar — mTLS-authed streaming tar export of the whole jail
// (every readable file under workspaceBrowseRoot). Bytes are never handed to
// `tar` via a wildcard: the entry list is built with the same jail-safe walk
// fs/list uses (fsEntryForDirent — symlink escapes dropped, containment
// enforced) and secret-denylisted files are excluded before `tar` ever sees
// them, so the archive can never surface what fs/file would refuse to serve.
// Bounded by maxExportBytes: the total is pre-computed from stat() sizes and
// checked BEFORE any header is written, so an oversized jail is refused
// cleanly with 413 instead of dying partway through a stream.

const maxExportBytes = 512 * 1024 * 1024;

// Recursively walks the jail collecting file entries (never directories) for
// the export list. Resilient to a single unreadable subdirectory: that
// branch is skipped rather than failing the whole export, since (unlike
// fs/list, which is asked for one specific directory) this walk covers
// everything under the root and one bad permission bit should not block the
// rest of the archive.
//
// The walk is cycle-safe. fsEntryForDirent resolves a symlinked directory to
// its realpath and then only checks containment, so `ln -s .. loop` inside a
// workspace is a perfectly legal, contained, self-referencing directory — and
// following it re-walks the same subtree forever. Untracked, that is not a
// hypothetical: one 2-byte file plus one such link yields thousands of
// duplicate entries (inflating the byte total the export cap is checked
// against, and duplicating every file in the archive), and a slightly deeper
// jail dies with `RangeError: Maximum call stack size exceeded`, which
// surfaces as a 500. The route is unconditional, so BYO nodes are affected
// too, and this is the path "Export my files" depends on.
//
// `visited` is keyed on the resolved absolute path, which is sufficient
// because every path that reaches here is already canonical: the walk starts
// at the realpath'd workspaceBrowseRoot and fsEntryForDirent hands back a
// realpath for symlinks and parent-plus-name for real directories. The depth
// cap is an independent second backstop, so a cycle the key check somehow
// misses still terminates rather than exhausting the stack.
//
// None of this weakens containment: entries are still produced only by
// fsEntryForDirent, which drops anything that escapes the root. Skipping an
// already-visited directory can only ever remove duplicates.

const maxExportDepth = 64;

function collectExportEntries(rootPath, maps, visited = new Set(), depth = 0) {
  if (depth > maxExportDepth) return [];
  if (visited.has(rootPath)) return [];
  visited.add(rootPath);

  let dirents;
  try {
    dirents = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries = [];
  for (const dirent of dirents) {
    const entry = fsEntryForDirent(rootPath, dirent, maps);
    if (!entry) continue;
    if (entry.kind === "dir") {
      entries.push(...collectExportEntries(entry.absolutePath, maps, visited, depth + 1));
      continue;
    }
    if (entry.kind === "file" && !entry.readDenied) {
      entries.push(entry);
    }
  }
  return entries;
}


function serveExportTar(req, res) {
  const maps = browseWorkspaceMaps();
  const entries = collectExportEntries(workspaceBrowseRoot, maps);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (totalBytes > maxExportBytes) {
    throw Object.assign(new Error("export_too_large"), { status: 413 });
  }

  res.writeHead(200, {
    "content-type": "application/x-tar",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-disposition": 'attachment; filename="relay-workspaces.tar"',
  });

  // Paths are handed to `tar` over stdin (`-T -`), NUL-separated, rather than
  // as argv entries: an export of a large jail can list far more files than
  // fit under a platform's ARG_MAX, and stdin has no such ceiling. NUL
  // separation (`--null`) is required, not just preferred: both bsdtar and
  // GNU tar treat a bare `-C` line in a `-T` list as a "change directory"
  // directive, and workspace filenames are attacker-controlled — a filename
  // containing embedded newlines (only `/` is illegal in a POSIX filename)
  // can inject a fake `-C\n..\n<target>` directive into a newline-joined
  // list and walk tar outside workspaceBrowseRoot. `--null` disables that
  // directive parsing entirely (documented behavior for both tar
  // implementations) as well as the newline ambiguity, so it is the fix, not
  // a hardening extra.
  //
  // `--null` is necessary but NOT sufficient on its own: a list field that is
  // literally `..` still escapes `-C` on both tar implementations. What makes
  // this safe is that every field comes from `entry.path`, built by
  // relativeBrowsePath/resolvedPathWithinRoot from an already root-contained
  // realpath. If this list ever accepts a less-trusted path source, that
  // containment — not `--null` — is the invariant that must be re-established.
  const child = spawn("tar", ["-cf", "-", "-C", workspaceBrowseRoot, "--null", "-T", "-"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.resume();
  child.on("error", () => {
    if (!res.writableEnded) res.end();
  });
  res.on("close", () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  // `tar` may exit (or never start reading stdin) before the file list is
  // fully written — a spawn failure or an empty jail both close the pipe
  // early. That surfaces as EPIPE on the stdin socket, which must not crash
  // the daemon; the child's own "error"/"close" handling above decides the
  // response outcome. Mirrors the same guard around job stdin in jobs.mjs.
  child.stdin.on("error", (error) => {
    if (error?.code !== "EPIPE") console.error(`export.tar: stdin write failed: ${error.message || error}`);
  });
  child.stdout.pipe(res);
  child.stdin.end(entries.map((entry) => entry.path).join("\0") + "\0");
}


export {
  isReadDeniedName,
  fsTextMimeByExtension,
  fsBinaryMimeByExtension,
  fsTextBasenames,
  mimeHintForFilename,
  cleanFsListOffset,
  cleanFsListLimit,
  fsListResponse,
  collectFsEntries,
  fsEntryForDirent,
  isTruthyQueryParam,
  parseByteRange,
  serveFsFile,
  serveFsFilePreview,
  maxExportBytes,
  maxExportDepth,
  collectExportEntries,
  serveExportTar,
};
