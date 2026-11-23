// Git inspection and action routes for Relay (/v1/codex/git/*).
//
// Security invariants:
// - Every requested path is resolved through resolveBrowsePath(..., { kind: "dir" })
//   and stays strictly inside workspaceBrowseRoot.
// - git and gh are always invoked via execFile with fixed argument arrays (no shell),
//   safe.directory=*, core.fsmonitor=, --no-optional-locks, timeouts, and non-interactive env.
// - Every returned file entry in status / diff / commit-diff is filtered through
//   isReadDeniedName(basename) and relative containment checks. Discard refuses any
//   read-denied or escaping path before performing any mutation.

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { gitBin, pathWithinRoot, workspaceBrowseRoot } from "./config.mjs";
import { isReadDeniedName } from "./fsapi.mjs";
import { cleanApiText } from "./util.mjs";
import { resolveBrowsePath, resolvedPathWithinRoot } from "./workspaces.mjs";

const DEFAULT_GIT_TIMEOUT_MS = 15_000;
const PUSH_GIT_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_MAX_BUFFER = 8 * 1024 * 1024;
const GH_TIMEOUT_MS = 2_000;
const GH_CACHE_TTL_MS = 30_000;
const GH_CACHE_MAX_ENTRIES = 200;

const MAX_DIFF_LINES = 8_000;
const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_UNTRACKED_DIFF_BYTES = 256 * 1024;
const MAX_UNTRACKED_STATUS_BYTES = 512 * 1024;
const MAX_DISCARD_FILES = 500;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
const DEFAULT_COMMITS_LIMIT = 30;
const MAX_COMMITS_LIMIT = 200;
const SHA_RE = /^[a-f0-9]{4,40}$/i;

const prCache = new Map();

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function assertJsonObject(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw httpError(400, "request body must be a JSON object");
  }
}

function resolveTargetDir(rawPath, fieldName = "path") {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw httpError(400, `${fieldName} is required`);
  }
  return resolveBrowsePath(rawPath, { kind: "dir" }).path;
}

// Walk parents up to workspaceBrowseRoot looking for `.git` (dir or worktree file).
// Never escapes workspaceBrowseRoot.
function findGitRoot(startDir) {
  let current = startDir;
  while (resolvedPathWithinRoot(current)) {
    try {
      const stat = fs.statSync(path.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) {
        const real = fs.realpathSync(current);
        return resolvedPathWithinRoot(real) ? real : null;
      }
    } catch {
      // Missing `.git` at this level; keep walking up inside the jail.
    }
    if (current === workspaceBrowseRoot) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

function requireGitRoot(rawPath, fieldName = "path") {
  const targetDir = resolveTargetDir(rawPath, fieldName);
  const repoRoot = findGitRoot(targetDir);
  if (!repoRoot) {
    throw httpError(400, "directory is not a git repository");
  }
  return repoRoot;
}

function runGit(
  repoRoot,
  args,
  { timeoutMs = DEFAULT_GIT_TIMEOUT_MS, maxBuffer = DEFAULT_GIT_MAX_BUFFER } = {},
) {
  return new Promise((resolve) => {
    execFile(
      gitBin,
      [
        "-c", "safe.directory=*",
        "-c", "core.fsmonitor=",
        "--no-optional-locks",
        "-C", repoRoot,
        ...args,
      ],
      {
        timeout: timeoutMs,
        maxBuffer,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "",
        },
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({
            ok: true,
            code: 0,
            stdout: stdout || "",
            stderr: stderr || "",
            timedOut: false,
            truncated: false,
          });
          return;
        }
        resolve({
          ok: false,
          code: typeof error.code === "number" ? error.code : null,
          stdout: stdout || "",
          stderr: stderr || "",
          message: error.message || String(error),
          timedOut: Boolean(error.killed) || error.code === "ETIMEDOUT",
          truncated: error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        });
      },
    );
  });
}

function gitTimeoutError() {
  return httpError(503, "git command timed out");
}

function assertNotTimedOut(result) {
  if (result.timedOut) throw gitTimeoutError();
}

function isSafeRepoRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (/[\0\r\n\\]/.test(relPath)) return false;
  if (path.isAbsolute(relPath) || relPath.startsWith("/")) return false;
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (!segment || segment === "." || segment === "..") return false;
  }
  return true;
}

function isDeniedRelPath(relPath) {
  if (!relPath) return false;
  return isReadDeniedName(path.basename(relPath));
}

function validateRequestedRepoFile(repoRoot, rawFile) {
  if (typeof rawFile !== "string" || !rawFile.trim()) {
    throw httpError(400, "file path is invalid");
  }
  const normalized = rawFile.trim();
  if (!isSafeRepoRelPath(normalized)) {
    throw httpError(400, "file path must be a relative path inside the repository");
  }
  const segments = normalized.split("/");
  if (segments.includes(".git")) {
    throw httpError(400, "file path cannot target .git metadata");
  }
  if (isDeniedRelPath(normalized)) {
    throw httpError(403, "file matches the read denylist");
  }

  const absTarget = path.resolve(repoRoot, normalized);
  if (!pathWithinRoot(absTarget, repoRoot) || absTarget === repoRoot) {
    throw httpError(400, "file path must stay inside the repository");
  }

  // Ensure no existing parent directory between repoRoot and the file is a symlink.
  let current = repoRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) {
      throw httpError(400, "file path must not traverse a symlink");
    }
    if (!stat.isDirectory()) {
      throw httpError(400, "file path parent is not a directory");
    }
  }

  // If the target exists on disk and is not a symlink itself, verify its realpath
  // stays inside the repo/jail and does not resolve to a read-denied basename.
  const targetLstat = fs.lstatSync(absTarget, { throwIfNoEntry: false });
  if (targetLstat) {
    if (targetLstat.isSymbolicLink()) {
      try {
        const real = fs.realpathSync(absTarget);
        if (!pathWithinRoot(real, repoRoot) || !resolvedPathWithinRoot(real)) {
          return { relPath: normalized, absPath: absTarget, targetLstat, escapesIfFollowed: true };
        }
        if (isReadDeniedName(path.basename(real))) {
          throw httpError(403, "file matches the read denylist");
        }
      } catch (error) {
        if (error?.status) throw error;
        // Dangling symlink inside repoRoot — safe to discard the link itself, never read target.
      }
    } else {
      const real = fs.realpathSync(absTarget);
      if (!pathWithinRoot(real, repoRoot) || !resolvedPathWithinRoot(real)) {
        throw httpError(400, "file path must stay inside the repository");
      }
      if (isReadDeniedName(path.basename(real))) {
        throw httpError(403, "file matches the read denylist");
      }
    }
  }

  return { relPath: normalized, absPath: absTarget, targetLstat, escapesIfFollowed: false };
}

// Safely inspect an untracked file on disk inside repoRoot. Never follows symlinks
// (git tracks symlinks as link-target blobs, not target file contents) and refuses
// read-denied files or anything resolving outside repoRoot / workspaceBrowseRoot.
function openSafeUntrackedFile(repoRoot, relPath) {
  if (!isSafeRepoRelPath(relPath) || isDeniedRelPath(relPath)) return null;
  const segments = relPath.split("/");
  if (segments.includes(".git")) return null;

  let current = repoRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return null;
  }

  const absPath = path.join(current, segments[segments.length - 1]);
  const lstat = fs.lstatSync(absPath, { throwIfNoEntry: false });
  if (!lstat || lstat.isSymbolicLink() || !lstat.isFile()) return null;

  let real;
  try {
    real = fs.realpathSync(absPath);
  } catch {
    return null;
  }
  if (!pathWithinRoot(real, repoRoot) || !resolvedPathWithinRoot(real)) return null;
  if (isReadDeniedName(path.basename(real))) return null;

  return { path: real, size: lstat.size };
}

function readUntrackedFileStats(filePath, size, maxBytes) {
  if (size === 0) return { lines: 0, binary: false, oversized: false };
  const probeSize = Math.min(size, maxBytes);
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(probeSize);
    const bytesRead = fs.readSync(fd, buf, 0, probeSize, 0);
    if (bytesRead === 0) return { lines: 0, binary: false, oversized: false };
    let lines = 0;
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return { lines: 0, binary: true, oversized: false };
      if (buf[i] === 10) lines += 1;
    }
    if (size > maxBytes) {
      return { lines: 0, binary: false, oversized: true };
    }
    if (buf[bytesRead - 1] !== 10) lines += 1;
    return { lines, binary: false, oversized: false };
  } catch {
    return { lines: 0, binary: false, oversized: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readUntrackedTextBuffer(filePath, size, maxBytes) {
  if (size > maxBytes) return { oversized: true, binary: false, text: null };
  if (size === 0) return { oversized: false, binary: false, text: "" };
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buf, 0, size, 0);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return { oversized: false, binary: true, text: null };
    }
    return { oversized: false, binary: false, text: buf.subarray(0, bytesRead).toString("utf8") };
  } catch {
    return { oversized: false, binary: false, text: null };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function hasGitHead(repoRoot) {
  const res = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  assertNotTimedOut(res);
  return res.ok && Boolean(res.stdout.trim());
}

async function emptyTreeSha(repoRoot) {
  const res = await runGit(repoRoot, ["hash-object", "-t", "tree", "/dev/null"]);
  assertNotTimedOut(res);
  if (res.ok && res.stdout.trim()) return res.stdout.trim();
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

async function currentBranch(repoRoot) {
  const sym = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  assertNotTimedOut(sym);
  if (sym.ok && sym.stdout.trim()) {
    return { branch: sym.stdout.trim().slice(0, 200), detached: false };
  }
  const sha = await runGit(repoRoot, ["rev-parse", "--short=7", "HEAD"]);
  assertNotTimedOut(sha);
  if (sha.ok && sha.stdout.trim()) {
    return { branch: sha.stdout.trim().slice(0, 200), detached: true };
  }
  return { branch: null, detached: false };
}

async function refExists(repoRoot, ref) {
  const res = await runGit(repoRoot, ["show-ref", "--verify", "--quiet", ref]);
  assertNotTimedOut(res);
  return res.ok;
}

async function detectBaseBranch(repoRoot) {
  const originHead = await runGit(repoRoot, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  assertNotTimedOut(originHead);
  if (originHead.ok && originHead.stdout.trim()) {
    const ref = originHead.stdout.trim();
    const prefix = "refs/remotes/origin/";
    if (ref.startsWith(prefix)) {
      const name = ref.slice(prefix.length);
      if (name) return name;
    }
  }
  if (await refExists(repoRoot, "refs/heads/main")) return "main";
  if (await refExists(repoRoot, "refs/heads/master")) return "master";
  if (await refExists(repoRoot, "refs/remotes/origin/main")) return "main";
  if (await refExists(repoRoot, "refs/remotes/origin/master")) return "master";
  return null;
}

async function resolveBaseBranchRef(repoRoot, baseBranch) {
  if (!baseBranch) return null;
  if (await refExists(repoRoot, `refs/heads/${baseBranch}`)) return `refs/heads/${baseBranch}`;
  if (await refExists(repoRoot, `refs/remotes/origin/${baseBranch}`)) return `refs/remotes/origin/${baseBranch}`;
  return null;
}

async function computeAheadBehind(repoRoot, branch, baseBranch, hasHead) {
  if (!hasHead) return { ahead: 0, behind: 0 };
  const upstream = await runGit(repoRoot, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]);
  assertNotTimedOut(upstream);
  if (upstream.ok) {
    const parsed = parseAheadBehind(upstream.stdout);
    if (parsed) return parsed;
  }
  if (baseBranch && baseBranch !== branch) {
    const baseRef = await resolveBaseBranchRef(repoRoot, baseBranch);
    if (baseRef) {
      const vsBase = await runGit(repoRoot, ["rev-list", "--left-right", "--count", `${baseRef}...HEAD`]);
      assertNotTimedOut(vsBase);
      if (vsBase.ok) {
        const parsed = parseAheadBehind(vsBase.stdout);
        if (parsed) return parsed;
      }
    }
  }
  return { ahead: 0, behind: 0 };
}

function parseAheadBehind(stdout) {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isSafeInteger(behind) || !Number.isSafeInteger(ahead)) return null;
  return { ahead, behind };
}

// Parse `git status --porcelain=v1 -z --untracked-files=all`.
// Entries are NUL-terminated: `XY PATH\0`, and for renames/copies (`R`/`C` in X or Y):
// `XY NEWPATH\0OLDPATH\0`.
function parsePorcelainStatusZ(stdout) {
  const records = stdout.split("\0");
  const entries = [];
  let i = 0;
  while (i < records.length) {
    const record = records[i];
    if (!record) break;
    if (record.length < 4) {
      i += 1;
      continue;
    }
    const x = record[0];
    const y = record[1];
    const filePath = record.slice(3);
    let oldPath = null;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      oldPath = records[i + 1] || null;
      i += 2;
    } else {
      i += 1;
    }
    if (x === "!" && y === "!") continue;
    entries.push({ x, y, path: filePath, oldPath });
  }
  return entries;
}

function mapPorcelainStatus(x, y) {
  if (x === "?" && y === "?") {
    return { status: "untracked", staged: false, unstaged: true };
  }
  const staged = x !== " " && x !== "?";
  const unstaged = y !== " " && y !== "?";
  let status = "modified";
  if (x === "R" || y === "R") {
    status = "renamed";
  } else if (x === "A" || x === "C") {
    status = y === "D" ? "deleted" : "added";
  } else if (x === "D" || y === "D") {
    status = "deleted";
  }
  return { status, staged, unstaged };
}

// Parse `git diff --numstat -z -M`.
// Regular record: "<added>\t<deleted>\t<path>\0"
// Rename record:  "<added>\t<deleted>\t\0<oldPath>\0<newPath>\0"
function parseNumstatZ(stdout) {
  const tokens = stdout.split("\0");
  const statsByPath = new Map();
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (!token) {
      i += 1;
      continue;
    }
    const firstTab = token.indexOf("\t");
    if (firstTab === -1) {
      i += 1;
      continue;
    }
    const secondTab = token.indexOf("\t", firstTab + 1);
    if (secondTab === -1) {
      i += 1;
      continue;
    }
    const addedField = token.slice(0, firstTab);
    const deletedField = token.slice(firstTab + 1, secondTab);
    let filePath = token.slice(secondTab + 1);
    if (filePath === "") {
      // Rename/copy entry: next two NUL-separated tokens are oldPath and newPath.
      const newPath = tokens[i + 2] ?? "";
      filePath = newPath;
      i += 3;
    } else {
      i += 1;
    }
    if (!filePath) continue;
    const binary = addedField === "-" || deletedField === "-";
    const added = binary ? 0 : (Number.isSafeInteger(Number(addedField)) ? Number(addedField) : 0);
    const deleted = binary ? 0 : (Number.isSafeInteger(Number(deletedField)) ? Number(deletedField) : 0);
    statsByPath.set(filePath, { added, deleted, binary });
  }
  return statsByPath;
}

async function collectStatusFiles(repoRoot, hasHead) {
  const baseTree = hasHead ? "HEAD" : await emptyTreeSha(repoRoot);
  const [statusRes, numstatRes] = await Promise.all([
    runGit(repoRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    runGit(repoRoot, ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "-M", baseTree]),
  ]);
  assertNotTimedOut(statusRes);
  assertNotTimedOut(numstatRes);

  const rawEntries = statusRes.ok ? parsePorcelainStatusZ(statusRes.stdout) : [];
  const numstatByPath = numstatRes.ok ? parseNumstatZ(numstatRes.stdout) : new Map();

  const files = [];
  let totalAdded = 0;
  let totalDeleted = 0;

  for (const entry of rawEntries) {
    // Skip embedded repo / worktree directories reported with trailing `/`.
    if (entry.path.endsWith("/")) continue;
    if (!isSafeRepoRelPath(entry.path)) continue;
    if (entry.oldPath && !isSafeRepoRelPath(entry.oldPath)) continue;
    if (isDeniedRelPath(entry.path) || isDeniedRelPath(entry.oldPath)) continue;

    const mapped = mapPorcelainStatus(entry.x, entry.y);
    let added = 0;
    let deleted = 0;
    let binary = false;

    if (mapped.status === "untracked") {
      const safeFile = openSafeUntrackedFile(repoRoot, entry.path);
      if (safeFile) {
        const counted = readUntrackedFileStats(safeFile.path, safeFile.size, MAX_UNTRACKED_STATUS_BYTES);
        added = counted.lines;
        binary = counted.binary;
      }
    } else {
      const stat = numstatByPath.get(entry.path);
      if (stat) {
        added = stat.added;
        deleted = stat.deleted;
        binary = stat.binary;
      }
    }

    totalAdded += added;
    totalDeleted += deleted;
    files.push({
      path: entry.path,
      oldPath: mapped.status === "renamed" ? entry.oldPath : null,
      status: mapped.status,
      staged: mapped.staged,
      unstaged: mapped.unstaged,
      added,
      deleted,
      binary,
    });
  }

  return { files, added: totalAdded, deleted: totalDeleted, dirty: files.length > 0 };
}

async function summarizeWorkingTreeStats(repoRoot) {
  const hasHead = await hasGitHead(repoRoot);
  const { dirty, added, deleted } = await collectStatusFiles(repoRoot, hasHead);
  return { dirty, added, deleted };
}

function deriveChecksStatus(rollup) {
  if (!Array.isArray(rollup) || rollup.length === 0) return "none";
  let hasFailing = false;
  let hasPending = false;
  let hasPassing = false;

  for (const item of rollup) {
    if (!item || typeof item !== "object") continue;
    const conclusion = typeof item.conclusion === "string" ? item.conclusion.toUpperCase() : "";
    const status = typeof item.status === "string" ? item.status.toUpperCase() : "";
    const state = typeof item.state === "string" ? item.state.toUpperCase() : "";

    if (
      ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"].includes(conclusion) ||
      ["FAILURE", "ERROR"].includes(state)
    ) {
      hasFailing = true;
    } else if (
      (status && status !== "COMPLETED") ||
      ["PENDING", "EXPECTED"].includes(state) ||
      (!conclusion && !state && status === "COMPLETED")
    ) {
      hasPending = true;
    } else if (
      ["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion) ||
      state === "SUCCESS"
    ) {
      hasPassing = true;
    }
  }

  if (hasFailing) return "failing";
  if (hasPending) return "pending";
  if (hasPassing) return "passing";
  return "none";
}

function clearPrCache(repoRoot = null) {
  if (!repoRoot) {
    prCache.clear();
    return;
  }
  const prefix = `${repoRoot}\0`;
  for (const key of prCache.keys()) {
    if (key.startsWith(prefix)) prCache.delete(key);
  }
}

function lookupPrInfo(repoRoot, branch, detached) {
  if (!branch || detached) return Promise.resolve(null);
  const cacheKey = `${repoRoot}\0${branch}`;
  const now = Date.now();
  const cached = prCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached.value);
  }

  const ghBin = process.env.RELAYD_GH_BIN || "gh";
  return new Promise((resolve) => {
    execFile(
      ghBin,
      ["pr", "view", "--json", "number,title,state,url,headRefName,statusCheckRollup"],
      {
        cwd: repoRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: 512 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          GH_PROMPT_DISABLED: "1",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout) => {
        let value = null;
        if (!error && stdout) {
          try {
            const parsed = JSON.parse(stdout);
            if (parsed && typeof parsed === "object" && Number.isInteger(parsed.number)) {
              value = {
                number: parsed.number,
                title: cleanApiText(parsed.title || ""),
                state: cleanApiText(parsed.state || "OPEN"),
                url: typeof parsed.url === "string" ? parsed.url : "",
                headBranch: cleanApiText(parsed.headRefName || branch),
                checksStatus: deriveChecksStatus(parsed.statusCheckRollup),
              };
            }
          } catch {
            value = null;
          }
        }
        if (prCache.size >= GH_CACHE_MAX_ENTRIES) {
          const oldestKey = prCache.keys().next().value;
          if (oldestKey !== undefined) prCache.delete(oldestKey);
        }
        prCache.set(cacheKey, { value, expiresAt: Date.now() + GH_CACHE_TTL_MS });
        resolve(value);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Unified diff parsing
// ---------------------------------------------------------------------------

function unquoteGitPath(raw) {
  const text = String(raw || "").trim();
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) {
    return text;
  }
  const bytes = [];
  for (let i = 1; i < text.length - 1; i++) {
    const ch = text[i];
    if (ch !== "\\") {
      bytes.push(...Buffer.from(ch, "utf8"));
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (next >= "0" && next <= "7") {
      const oct = text.slice(i + 1, i + 4);
      if (/^[0-7]{3}$/.test(oct)) {
        bytes.push(parseInt(oct, 8));
        i += 3;
        continue;
      }
    }
    const escapeMap = {
      "\\": 0x5c,
      '"': 0x22,
      a: 0x07,
      b: 0x08,
      f: 0x0c,
      n: 0x0a,
      r: 0x0d,
      t: 0x09,
      v: 0x0b,
    };
    if (escapeMap[next] !== undefined) {
      bytes.push(escapeMap[next]);
    } else {
      bytes.push(...Buffer.from(next, "utf8"));
    }
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripDiffPrefix(rawPath, expectedPrefix) {
  const unquoted = unquoteGitPath(rawPath);
  if (unquoted === "/dev/null") return null;
  if (expectedPrefix && unquoted.startsWith(expectedPrefix)) {
    return unquoted.slice(expectedPrefix.length);
  }
  return unquoted;
}

function readQuotedSegment(text, startIndex) {
  let i = startIndex + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      return { raw: text.slice(startIndex, i + 1), nextIndex: i + 1 };
    }
    i += 1;
  }
  return { raw: text.slice(startIndex), nextIndex: text.length };
}

function parseDiffGitLine(line) {
  const rest = line.slice("diff --git ".length);
  if (!rest) return { oldPath: null, newPath: null };

  if (rest.startsWith('"')) {
    const first = readQuotedSegment(rest, 0);
    const secondPart = rest.slice(first.nextIndex).trimStart();
    const secondRaw = secondPart.startsWith('"')
      ? readQuotedSegment(secondPart, 0).raw
      : secondPart;
    return {
      oldPath: stripDiffPrefix(first.raw, "a/"),
      newPath: stripDiffPrefix(secondRaw, "b/"),
    };
  }

  // If the second path is quoted, split at ` "b/`.
  const quotedSecondIdx = rest.indexOf(' "b/');
  if (quotedSecondIdx !== -1) {
    const firstRaw = rest.slice(0, quotedSecondIdx);
    const secondRaw = rest.slice(quotedSecondIdx + 1);
    return {
      oldPath: stripDiffPrefix(firstRaw, "a/"),
      newPath: stripDiffPrefix(secondRaw, "b/"),
    };
  }

  // Fast exact path for identical old/new filenames (including spaces).
  if (rest.length % 2 === 1) {
    const mid = (rest.length - 1) / 2;
    if (rest[mid] === " ") {
      const left = rest.slice(0, mid);
      const right = rest.slice(mid + 1);
      if (left.startsWith("a/") && right.startsWith("b/") && left.slice(2) === right.slice(2)) {
        const p = left.slice(2);
        return { oldPath: p, newPath: p };
      }
    }
  }

  const splitIdx = rest.indexOf(" b/");
  if (splitIdx !== -1) {
    return {
      oldPath: stripDiffPrefix(rest.slice(0, splitIdx), "a/"),
      newPath: stripDiffPrefix(rest.slice(splitIdx + 1), "b/"),
    };
  }
  return { oldPath: null, newPath: null };
}

function parseUnifiedDiff(diffText, { budget, initiallyTruncated = false } = {}) {
  const state = budget || {
    lines: 0,
    bytes: 0,
    truncated: initiallyTruncated,
  };
  if (initiallyTruncated) state.truncated = true;

  const rawFiles = [];
  let currentFile = null;
  let currentHunk = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const finalizeFile = () => {
    if (!currentFile) return;
    if (currentFile.truncatedBeforeFile) {
      currentFile = null;
      currentHunk = null;
      oldRemaining = 0;
      newRemaining = 0;
      return;
    }
    let finalPath = currentFile.newPath || currentFile.oldPath;
    let finalOldPath = null;
    if (currentFile.status === "deleted") {
      finalPath = currentFile.oldPath || currentFile.newPath;
      finalOldPath = null;
    } else if (currentFile.status === "renamed") {
      finalPath = currentFile.newPath || currentFile.oldPath;
      finalOldPath = currentFile.oldPath || null;
    } else if (currentFile.status === "added") {
      finalPath = currentFile.newPath || currentFile.oldPath;
      finalOldPath = null;
    }

    if (
      finalPath &&
      isSafeRepoRelPath(finalPath) &&
      (!finalOldPath || isSafeRepoRelPath(finalOldPath)) &&
      !isDeniedRelPath(finalPath) &&
      !isDeniedRelPath(finalOldPath)
    ) {
      rawFiles.push({
        path: finalPath,
        oldPath: finalOldPath,
        status: currentFile.status,
        added: currentFile.added,
        deleted: currentFile.deleted,
        binary: currentFile.binary,
        hunks: currentFile.hunks,
      });
    }
    currentFile = null;
    currentHunk = null;
    oldRemaining = 0;
    newRemaining = 0;
  };

  const lines = diffText ? diffText.split("\n") : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inside an open hunk body: consume exact expected old/new line counts so
    // code lines starting with `--- `, `+++ `, or `@@ ` are never misparsed.
    if (currentHunk && (oldRemaining > 0 || newRemaining > 0)) {
      if (line.startsWith("\\")) {
        continue;
      }
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-")) {
        const prefix = line[0];
        const text = cleanApiText(line.slice(1));
        if (prefix === " ") {
          oldRemaining = Math.max(0, oldRemaining - 1);
          newRemaining = Math.max(0, newRemaining - 1);
          pushHunkLine(currentFile, currentHunk, { kind: "context", oldLine: oldLine++, newLine: newLine++, text }, state);
        } else if (prefix === "+") {
          newRemaining = Math.max(0, newRemaining - 1);
          if (!currentFile.denied) {
            pushHunkLine(currentFile, currentHunk, { kind: "add", oldLine: null, newLine: newLine++, text }, state);
          } else {
            newLine += 1;
          }
        } else if (prefix === "-") {
          oldRemaining = Math.max(0, oldRemaining - 1);
          if (!currentFile.denied) {
            pushHunkLine(currentFile, currentHunk, { kind: "delete", oldLine: oldLine++, newLine: null, text }, state);
          } else {
            oldLine += 1;
          }
        }
        continue;
      }
      // Malformed / truncated diff stream fell out of hunk early.
      oldRemaining = 0;
      newRemaining = 0;
    }

    if (line.startsWith("diff --git ")) {
      finalizeFile();
      const parsedPaths = parseDiffGitLine(line);
      currentFile = {
        oldPath: parsedPaths.oldPath,
        newPath: parsedPaths.newPath,
        status: "modified",
        added: 0,
        deleted: 0,
        binary: false,
        hunks: [],
        denied: isDeniedRelPath(parsedPaths.oldPath) || isDeniedRelPath(parsedPaths.newPath),
        truncatedBeforeFile: state.truncated,
      };
      currentHunk = null;
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("@@ ")) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
      if (match) {
        const oldStart = Number(match[1]);
        const oldCount = match[2] === undefined ? 1 : Number(match[2]);
        const newStart = Number(match[3]);
        const newCount = match[4] === undefined ? 1 : Number(match[4]);
        oldLine = oldStart;
        newLine = newStart;
        oldRemaining = oldCount;
        newRemaining = newCount;
        currentHunk = {
          header: cleanApiText(line),
          oldStart,
          oldCount,
          newStart,
          newCount,
          lines: [],
        };
        if (!currentFile.denied && !state.truncated) {
          currentFile.hunks.push(currentHunk);
        }
      }
      continue;
    }

    if (line.startsWith("new file mode ")) {
      currentFile.status = "added";
    } else if (line.startsWith("deleted file mode ")) {
      currentFile.status = "deleted";
    } else if (line.startsWith("rename from ")) {
      currentFile.status = "renamed";
      currentFile.oldPath = unquoteGitPath(line.slice("rename from ".length));
      if (isDeniedRelPath(currentFile.oldPath)) currentFile.denied = true;
    } else if (line.startsWith("rename to ")) {
      currentFile.status = "renamed";
      currentFile.newPath = unquoteGitPath(line.slice("rename to ".length));
      if (isDeniedRelPath(currentFile.newPath)) currentFile.denied = true;
    } else if (line.startsWith("copy from ")) {
      currentFile.oldPath = unquoteGitPath(line.slice("copy from ".length));
      if (isDeniedRelPath(currentFile.oldPath)) currentFile.denied = true;
    } else if (line.startsWith("copy to ")) {
      currentFile.status = "added";
      currentFile.newPath = unquoteGitPath(line.slice("copy to ".length));
      if (isDeniedRelPath(currentFile.newPath)) currentFile.denied = true;
    } else if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      currentFile.binary = true;
    } else if (line.startsWith("--- ")) {
      const stripped = stripDiffPrefix(line.slice(4), "a/");
      if (stripped === null) {
        currentFile.status = "added";
      } else {
        currentFile.oldPath = stripped;
        if (isDeniedRelPath(stripped)) currentFile.denied = true;
      }
    } else if (line.startsWith("+++ ")) {
      const stripped = stripDiffPrefix(line.slice(4), "b/");
      if (stripped === null) {
        currentFile.status = "deleted";
      } else {
        currentFile.newPath = stripped;
        if (isDeniedRelPath(stripped)) currentFile.denied = true;
      }
    }
  }

  finalizeFile();
  return { files: rawFiles, truncated: state.truncated };
}

function pushHunkLine(file, hunk, entry, state) {
  if (file.denied) return;
  if (state.truncated) return;
  const lineBytes = Buffer.byteLength(entry.text, "utf8") + 16;
  if (state.lines + 1 > MAX_DIFF_LINES || state.bytes + lineBytes > MAX_DIFF_BYTES) {
    state.truncated = true;
    return;
  }
  state.lines += 1;
  state.bytes += lineBytes;
  if (entry.kind === "add") file.added += 1;
  else if (entry.kind === "delete") file.deleted += 1;
  hunk.lines.push(entry);
}

async function buildUntrackedDiffFiles(repoRoot, fileFilter, state) {
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
  if (fileFilter) statusArgs.push("--", fileFilter);
  const statusRes = await runGit(repoRoot, statusArgs);
  assertNotTimedOut(statusRes);
  if (!statusRes.ok) return [];

  const entries = parsePorcelainStatusZ(statusRes.stdout);
  const untrackedFiles = [];

  for (const entry of entries) {
    if (entry.x !== "?" || entry.y !== "?") continue;
    if (entry.path.endsWith("/")) continue;
    if (fileFilter && entry.path !== fileFilter) continue;

    const safeFile = openSafeUntrackedFile(repoRoot, entry.path);
    if (!safeFile) continue;

    const read = readUntrackedTextBuffer(safeFile.path, safeFile.size, MAX_UNTRACKED_DIFF_BYTES);
    if (read.binary) continue;
    if (read.oversized) {
      state.truncated = true;
      continue;
    }
    if (read.text === null) continue;
    if (state.truncated) break;

    const text = read.text;
    let rawLines = [];
    if (text.length > 0) {
      rawLines = text.split("\n");
      if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
        rawLines.pop();
      }
    }

    const fileObj = {
      path: entry.path,
      oldPath: null,
      status: "untracked",
      added: 0,
      deleted: 0,
      binary: false,
      hunks: [],
    };

    if (rawLines.length > 0) {
      const hunk = {
        header: `@@ -0,0 +1,${rawLines.length} @@`,
        oldStart: 0,
        oldCount: 0,
        newStart: 1,
        newCount: rawLines.length,
        lines: [],
      };
      for (let i = 0; i < rawLines.length; i++) {
        if (state.truncated) break;
        pushHunkLine(
          fileObj,
          hunk,
          { kind: "add", oldLine: null, newLine: i + 1, text: cleanApiText(rawLines[i]) },
          state,
        );
      }
      if (hunk.lines.length > 0) {
        fileObj.hunks.push(hunk);
      }
    }

    untrackedFiles.push(fileObj);
  }

  return untrackedFiles;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// GET /v1/codex/git/status?path=<abs-dir>
async function gitStatus(searchParams) {
  const targetDir = resolveTargetDir(searchParams.get("path"), "path");
  const repoRoot = findGitRoot(targetDir);
  if (!repoRoot) {
    return {
      isGitRepo: false,
      repoRoot: null,
      branch: null,
      baseBranch: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      added: 0,
      deleted: 0,
      files: [],
      pr: null,
    };
  }

  const [branchInfo, baseBranch, hasHead] = await Promise.all([
    currentBranch(repoRoot),
    detectBaseBranch(repoRoot),
    hasGitHead(repoRoot),
  ]);

  const [aheadBehind, statusInfo, pr] = await Promise.all([
    computeAheadBehind(repoRoot, branchInfo.branch, baseBranch, hasHead),
    collectStatusFiles(repoRoot, hasHead),
    lookupPrInfo(repoRoot, branchInfo.branch, branchInfo.detached),
  ]);

  return {
    isGitRepo: true,
    repoRoot,
    branch: branchInfo.branch,
    baseBranch,
    ahead: aheadBehind.ahead,
    behind: aheadBehind.behind,
    dirty: statusInfo.dirty,
    added: statusInfo.added,
    deleted: statusInfo.deleted,
    files: statusInfo.files,
    pr,
  };
}

// GET /v1/codex/git/diff?path=<abs-dir>&mode=uncommitted|committed|all&file=<optional-rel-path>
async function gitDiff(searchParams) {
  const repoRoot = requireGitRoot(searchParams.get("path"), "path");
  const modeRaw = (searchParams.get("mode") || "uncommitted").trim().toLowerCase();
  if (!["uncommitted", "committed", "all"].includes(modeRaw)) {
    throw httpError(400, "mode must be uncommitted, committed, or all");
  }

  const rawFile = searchParams.get("file");
  let fileFilter = null;
  if (rawFile !== null && rawFile !== "") {
    const validated = validateRequestedRepoFile(repoRoot, rawFile);
    if (validated.escapesIfFollowed) {
      throw httpError(400, "file path must stay inside the repository");
    }
    fileFilter = validated.relPath;
  }

  const [branchInfo, baseBranch, hasHead] = await Promise.all([
    currentBranch(repoRoot),
    detectBaseBranch(repoRoot),
    hasGitHead(repoRoot),
  ]);

  const budget = { lines: 0, bytes: 0, truncated: false };
  let diffStdout = "";
  let gitTruncated = false;
  let includeUntracked = false;

  const baseArgs = ["-c", "core.quotepath=false", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "-M"];
  const pathspec = fileFilter ? ["--", fileFilter] : [];

  if (modeRaw === "uncommitted") {
    includeUntracked = true;
    const baseTree = hasHead ? "HEAD" : await emptyTreeSha(repoRoot);
    const diffRes = await runGit(repoRoot, [...baseArgs, baseTree, ...pathspec]);
    assertNotTimedOut(diffRes);
    diffStdout = diffRes.stdout || "";
    gitTruncated = diffRes.truncated;
  } else if (modeRaw === "committed") {
    if (hasHead && baseBranch) {
      const baseRef = await resolveBaseBranchRef(repoRoot, baseBranch);
      if (baseRef) {
        const mbRes = await runGit(repoRoot, ["merge-base", baseRef, "HEAD"]);
        assertNotTimedOut(mbRes);
        if (mbRes.ok && mbRes.stdout.trim()) {
          const mergeBase = mbRes.stdout.trim();
          const diffRes = await runGit(repoRoot, [...baseArgs, mergeBase, "HEAD", ...pathspec]);
          assertNotTimedOut(diffRes);
          diffStdout = diffRes.stdout || "";
          gitTruncated = diffRes.truncated;
        }
      }
    }
  } else if (modeRaw === "all") {
    includeUntracked = true;
    let compareRef = hasHead ? "HEAD" : await emptyTreeSha(repoRoot);
    if (hasHead && baseBranch) {
      const baseRef = await resolveBaseBranchRef(repoRoot, baseBranch);
      if (baseRef) {
        const mbRes = await runGit(repoRoot, ["merge-base", baseRef, "HEAD"]);
        assertNotTimedOut(mbRes);
        if (mbRes.ok && mbRes.stdout.trim()) {
          compareRef = mbRes.stdout.trim();
        }
      }
    }
    const diffRes = await runGit(repoRoot, [...baseArgs, compareRef, ...pathspec]);
    assertNotTimedOut(diffRes);
    diffStdout = diffRes.stdout || "";
    gitTruncated = diffRes.truncated;
  }

  const parsed = parseUnifiedDiff(diffStdout, { budget, initiallyTruncated: gitTruncated });
  const files = [...parsed.files];

  if (includeUntracked) {
    const existingPaths = new Set(files.map((f) => f.path));
    const untracked = await buildUntrackedDiffFiles(repoRoot, fileFilter, budget);
    for (const file of untracked) {
      if (!existingPaths.has(file.path)) {
        files.push(file);
      }
    }
  }

  let totalAdded = 0;
  let totalDeleted = 0;
  for (const file of files) {
    totalAdded += file.added;
    totalDeleted += file.deleted;
  }

  return {
    mode: modeRaw,
    branch: branchInfo.branch,
    baseBranch,
    totalAdded,
    totalDeleted,
    truncated: budget.truncated,
    files,
  };
}

// GET /v1/codex/git/commits?path=<abs-dir>&limit=30
async function gitCommits(searchParams) {
  const repoRoot = requireGitRoot(searchParams.get("path"), "path");
  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_COMMITS_LIMIT;
  if (rawLimit !== null && rawLimit !== "") {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw httpError(400, "limit must be a positive integer");
    }
    limit = Math.min(parsed, MAX_COMMITS_LIMIT);
  }

  const [branchInfo, hasHead] = await Promise.all([
    currentBranch(repoRoot),
    hasGitHead(repoRoot),
  ]);

  if (!hasHead) {
    return { branch: branchInfo.branch, commits: [] };
  }

  const logRes = await runGit(repoRoot, [
    "log",
    "-n", String(limit),
    "--format=%H%x00%h%x00%s%x00%an%x00%cr%x00%cI%x1e",
  ]);
  assertNotTimedOut(logRes);
  if (!logRes.ok) {
    return { branch: branchInfo.branch, commits: [] };
  }

  const commits = [];
  for (const record of logRes.stdout.split("\x1e")) {
    const trimmed = record.replace(/^\r?\n/, "");
    if (!trimmed) continue;
    const fields = trimmed.split("\x00");
    if (fields.length < 6) continue;
    const [sha, shortSha, subject, author, relativeDate, rawIso] = fields;
    let committedAt = rawIso.trim();
    const parsedTime = Date.parse(committedAt);
    if (Number.isFinite(parsedTime)) {
      committedAt = new Date(parsedTime).toISOString();
    }
    commits.push({
      sha: sha.trim(),
      shortSha: shortSha.trim(),
      subject: cleanApiText(subject),
      author: cleanApiText(author),
      relativeDate: cleanApiText(relativeDate),
      committedAt,
    });
  }

  return { branch: branchInfo.branch, commits };
}

// GET /v1/codex/git/commit-diff?path=<abs-dir>&sha=<hex>
async function gitCommitDiff(searchParams) {
  const repoRoot = requireGitRoot(searchParams.get("path"), "path");
  const rawSha = searchParams.get("sha");
  if (typeof rawSha !== "string" || !SHA_RE.test(rawSha.trim())) {
    throw httpError(400, "sha must be a 4 to 40 character hexadecimal string");
  }
  const sha = rawSha.trim();

  const rawFile = searchParams.get("file");
  let fileFilter = null;
  if (rawFile !== null && rawFile !== "") {
    const validated = validateRequestedRepoFile(repoRoot, rawFile);
    if (validated.escapesIfFollowed) {
      throw httpError(400, "file path must stay inside the repository");
    }
    fileFilter = validated.relPath;
  }

  const verify = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  assertNotTimedOut(verify);
  if (!verify.ok || !verify.stdout.trim()) {
    throw httpError(404, "commit not found");
  }
  const resolvedSha = verify.stdout.trim();

  const [branchInfo, baseBranch, showRes] = await Promise.all([
    currentBranch(repoRoot),
    detectBaseBranch(repoRoot),
    runGit(repoRoot, [
      "-c", "core.quotepath=false",
      "show",
      "--format=",
      "--root",
      "-m",
      "--first-parent",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "-M",
      resolvedSha,
      ...(fileFilter ? ["--", fileFilter] : []),
    ]),
  ]);
  assertNotTimedOut(showRes);

  const budget = { lines: 0, bytes: 0, truncated: false };
  const parsed = parseUnifiedDiff(showRes.stdout || "", {
    budget,
    initiallyTruncated: showRes.truncated,
  });

  let totalAdded = 0;
  let totalDeleted = 0;
  for (const file of parsed.files) {
    totalAdded += file.added;
    totalDeleted += file.deleted;
  }

  return {
    mode: "commit",
    sha: resolvedSha,
    branch: branchInfo.branch,
    baseBranch,
    totalAdded,
    totalDeleted,
    truncated: parsed.truncated,
    files: parsed.files,
  };
}

// GET /v1/codex/git/branches?path=<abs-dir>
async function gitBranches(searchParams) {
  const repoRoot = requireGitRoot(searchParams.get("path"), "path");
  const [branchInfo, baseBranch, refsRes] = await Promise.all([
    currentBranch(repoRoot),
    detectBaseBranch(repoRoot),
    runGit(repoRoot, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%00%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(symref)",
      "refs/heads",
      "refs/remotes",
    ]),
  ]);
  assertNotTimedOut(refsRes);

  const localBranches = [];
  const remoteBranches = [];

  if (refsRes.ok) {
    for (const line of refsRes.stdout.split("\n")) {
      if (!line) continue;
      const [refname, shortName, headMarker, upstreamShort, symref] = line.split("\0");
      if (!refname || !shortName) continue;
      // Skip symbolic remote HEAD pointers like refs/remotes/origin/HEAD.
      if (symref || refname.endsWith("/HEAD")) continue;
      const isRemote = refname.startsWith("refs/remotes/");
      const entry = {
        name: shortName,
        isCurrent: !isRemote && headMarker === "*",
        isRemote,
        upstream: upstreamShort || null,
      };
      if (isRemote) remoteBranches.push(entry);
      else localBranches.push(entry);
    }
  }

  // Put the current branch first among local branches.
  localBranches.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));

  return {
    current: branchInfo.branch,
    baseBranch,
    branches: [...localBranches, ...remoteBranches],
  };
}

async function validateBranchName(repoRoot, rawBranch, fieldName = "branch") {
  if (typeof rawBranch !== "string" || !rawBranch.trim()) {
    throw httpError(400, `${fieldName} is required`);
  }
  const branch = rawBranch.trim();
  if (/[\0\r\n]/.test(branch) || branch.startsWith("-") || branch === "HEAD" || branch === "@") {
    throw httpError(400, `invalid ${fieldName} name`);
  }
  const check = await runGit(repoRoot, ["check-ref-format", "--branch", branch]);
  assertNotTimedOut(check);
  if (!check.ok || !check.stdout.trim()) {
    throw httpError(400, `invalid ${fieldName} name`);
  }
  const normalized = check.stdout.trim();
  if (normalized.startsWith("-") || normalized === "HEAD" || normalized === "@") {
    throw httpError(400, `invalid ${fieldName} name`);
  }
  return normalized;
}

// POST /v1/codex/git/checkout ({ path, branch, create?: boolean })
async function gitCheckout(body) {
  assertJsonObject(body);
  const repoRoot = requireGitRoot(body.path, "path");
  if (body.create !== undefined && typeof body.create !== "boolean") {
    throw httpError(400, "create must be a boolean");
  }
  const create = body.create === true;
  const branch = await validateBranchName(repoRoot, body.branch, "branch");

  const args = create ? ["checkout", "-b", branch] : ["checkout", branch];
  const res = await runGit(repoRoot, args);
  assertNotTimedOut(res);

  if (!res.ok) {
    const detail = cleanApiText(res.stderr || res.stdout || "git checkout failed").trim();
    if (/already exists/i.test(detail)) {
      throw httpError(409, detail);
    }
    if (/would be overwritten|local changes/i.test(detail)) {
      throw httpError(409, detail);
    }
    if (/did not match any file|not a commit|pathspec/i.test(detail)) {
      throw httpError(404, detail);
    }
    throw httpError(400, detail || "git checkout failed");
  }

  clearPrCache(repoRoot);
  const after = await currentBranch(repoRoot);
  return { ok: true, branch: after.branch || branch };
}

// POST /v1/codex/git/discard ({ path, files: [relPath] })
async function gitDiscard(body) {
  assertJsonObject(body);
  const repoRoot = requireGitRoot(body.path, "path");
  if (!Array.isArray(body.files) || body.files.length === 0) {
    throw httpError(400, "files must be a non-empty array of relative paths");
  }
  if (body.files.length > MAX_DISCARD_FILES) {
    throw httpError(400, `files may contain at most ${MAX_DISCARD_FILES} entries`);
  }

  // Validate ALL requested paths up front before mutating any file.
  const validated = [];
  const seen = new Set();
  for (const rawFile of body.files) {
    const entry = validateRequestedRepoFile(repoRoot, rawFile);
    if (!seen.has(entry.relPath)) {
      seen.add(entry.relPath);
      validated.push(entry);
    }
  }

  const hasHead = await hasGitHead(repoRoot);
  const discarded = [];

  for (const entry of validated) {
    const { relPath, absPath } = entry;
    let inHead = false;
    if (hasHead) {
      const cat = await runGit(repoRoot, ["cat-file", "-e", `HEAD:${relPath}`]);
      assertNotTimedOut(cat);
      inHead = cat.ok;
    }

    if (inHead) {
      const checkout = await runGit(repoRoot, ["checkout", "HEAD", "--", relPath]);
      assertNotTimedOut(checkout);
      if (!checkout.ok) {
        const detail = cleanApiText(checkout.stderr || checkout.stdout || "git checkout failed").trim();
        throw httpError(400, detail || `failed to discard ${relPath}`);
      }
      discarded.push(relPath);
      continue;
    }

    // Check if the file is staged in the index (e.g., staged new file or rename target).
    const ls = await runGit(repoRoot, ["ls-files", "--error-unmatch", "--", relPath]);
    assertNotTimedOut(ls);
    if (ls.ok) {
      const rmCached = await runGit(repoRoot, ["rm", "-f", "--cached", "--", relPath]);
      assertNotTimedOut(rmCached);
      if (!rmCached.ok) {
        const detail = cleanApiText(rmCached.stderr || rmCached.stdout || "git rm failed").trim();
        throw httpError(400, detail || `failed to unstage ${relPath}`);
      }
      const stat = fs.lstatSync(absPath, { throwIfNoEntry: false });
      if (stat && (stat.isFile() || stat.isSymbolicLink())) {
        fs.unlinkSync(absPath);
      }
      discarded.push(relPath);
      continue;
    }

    // Otherwise it must be an untracked file inside repoRoot.
    const lstat = fs.lstatSync(absPath, { throwIfNoEntry: false });
    if (!lstat) {
      throw httpError(404, `file not found: ${relPath}`);
    }
    if (lstat.isDirectory()) {
      throw httpError(400, `cannot discard directory: ${relPath}`);
    }
    fs.unlinkSync(absPath);
    discarded.push(relPath);
  }

  return { ok: true, discarded };
}

// POST /v1/codex/git/commit ({ path, message, stageAll?: boolean, push?: boolean })
async function gitCommit(body) {
  assertJsonObject(body);
  const repoRoot = requireGitRoot(body.path, "path");

  if (typeof body.message !== "string" || !body.message.trim()) {
    throw httpError(400, "commit message is required");
  }
  const message = body.message.trim();
  if (Buffer.byteLength(message, "utf8") > MAX_COMMIT_MESSAGE_BYTES) {
    throw httpError(400, "commit message is too large");
  }

  if (body.stageAll !== undefined && typeof body.stageAll !== "boolean") {
    throw httpError(400, "stageAll must be a boolean");
  }
  if (body.push !== undefined && typeof body.push !== "boolean") {
    throw httpError(400, "push must be a boolean");
  }
  const stageAll = body.stageAll !== false;
  const push = body.push === true;

  if (stageAll) {
    const addRes = await runGit(repoRoot, ["add", "-A"]);
    assertNotTimedOut(addRes);
    if (!addRes.ok) {
      const detail = cleanApiText(addRes.stderr || addRes.stdout || "git add failed").trim();
      throw httpError(400, detail || "git add failed");
    }
  }

  const hasHead = await hasGitHead(repoRoot);
  if (hasHead) {
    const stagedCheck = await runGit(repoRoot, ["diff", "--cached", "--quiet"]);
    assertNotTimedOut(stagedCheck);
    if (stagedCheck.ok) {
      throw httpError(400, "nothing to commit");
    }
  } else {
    const stagedFiles = await runGit(repoRoot, ["ls-files", "--cached"]);
    assertNotTimedOut(stagedFiles);
    if (!stagedFiles.ok || !stagedFiles.stdout.trim()) {
      throw httpError(400, "nothing to commit");
    }
  }

  // Fallback identity ONLY if user.name / user.email are not configured.
  const [nameCfg, emailCfg] = await Promise.all([
    runGit(repoRoot, ["config", "--get", "user.name"]),
    runGit(repoRoot, ["config", "--get", "user.email"]),
  ]);
  assertNotTimedOut(nameCfg);
  assertNotTimedOut(emailCfg);

  const identityArgs = [];
  if (!nameCfg.ok || !nameCfg.stdout.trim()) {
    identityArgs.push("-c", "user.name=Relay");
  }
  if (!emailCfg.ok || !emailCfg.stdout.trim()) {
    identityArgs.push("-c", "user.email=relay@localhost");
  }

  const commitRes = await runGit(repoRoot, [...identityArgs, "commit", "-m", message]);
  assertNotTimedOut(commitRes);
  if (!commitRes.ok) {
    const detail = cleanApiText(commitRes.stderr || commitRes.stdout || "git commit failed").trim();
    throw httpError(400, detail || "git commit failed");
  }

  const [shaRes, shortShaRes, branchInfo] = await Promise.all([
    runGit(repoRoot, ["rev-parse", "HEAD"]),
    runGit(repoRoot, ["rev-parse", "--short=7", "HEAD"]),
    currentBranch(repoRoot),
  ]);
  assertNotTimedOut(shaRes);
  assertNotTimedOut(shortShaRes);

  const sha = shaRes.stdout.trim();
  const shortSha = shortShaRes.stdout.trim();
  const branch = branchInfo.branch;

  let pushed = false;
  let pushError = null;
  if (push) {
    const upstreamRes = await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    assertNotTimedOut(upstreamRes);
    let pushArgs = null;
    if (upstreamRes.ok && upstreamRes.stdout.trim()) {
      pushArgs = ["push"];
    } else {
      const remotesRes = await runGit(repoRoot, ["remote"]);
      assertNotTimedOut(remotesRes);
      const remotes = remotesRes.ok
        ? remotesRes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)
        : [];
      const remote = remotes.includes("origin") ? "origin" : remotes[0] || null;
      if (remote && branch && !branchInfo.detached) {
        pushArgs = ["push", "-u", remote, branch];
      } else {
        pushError = "no git remote configured";
      }
    }

    if (pushArgs) {
      const pushRes = await runGit(repoRoot, pushArgs, { timeoutMs: PUSH_GIT_TIMEOUT_MS });
      assertNotTimedOut(pushRes);
      if (pushRes.ok) {
        pushed = true;
      } else {
        pushError = cleanApiText(pushRes.stderr || pushRes.stdout || "git push failed").trim();
      }
    }
  }

  clearPrCache(repoRoot);
  const response = { ok: true, sha, shortSha, branch, pushed };
  if (pushError) response.pushError = pushError;
  return response;
}

export {
  httpError,
  assertJsonObject,
  resolveTargetDir,
  findGitRoot,
  requireGitRoot,
  runGit,
  assertNotTimedOut,
  isSafeRepoRelPath,
  isDeniedRelPath,
  hasGitHead,
  currentBranch,
  detectBaseBranch,
  refExists,
  validateBranchName,
  summarizeWorkingTreeStats,
  parseUnifiedDiff,
  clearPrCache,
  gitStatus,
  gitDiff,
  gitCommits,
  gitCommitDiff,
  gitBranches,
  gitCheckout,
  gitDiscard,
  gitCommit,
};
