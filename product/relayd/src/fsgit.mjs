// Working-tree snapshot for the phone's file viewer and explorer.
//
// The phone cannot see git itself. This route reports the branch and the
// insertion/deletion counts for one jailed file or directory, and the file's
// mtime, so the client can refresh while an editor on the machine is saving.
// Counts are the whole picture the response carries: paths, diffs, and git
// stderr stay on the machine.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { workspaceBrowseRoot } from "./config.mjs";
import { isReadDeniedName } from "./fsapi.mjs";
import { resolveBrowsePath, resolvedPathWithinRoot } from "./workspaces.mjs";

const gitTimeoutMs = 2500;
const directoryUntrackedFileCap = 40;
const directoryUntrackedByteCap = 128 * 1024;
const fileUntrackedByteCap = 2 * 1024 * 1024;

function resolveGitTarget(requested) {
  try {
    const file = resolveBrowsePath(requested, { kind: "file" });
    return { kind: "file", path: file.path, stat: file.stat };
  } catch (error) {
    if (error.status === 400 && error.message === "path is not a regular file") {
      const dir = resolveBrowsePath(requested, { kind: "dir" });
      return { kind: "dir", path: dir.path, stat: dir.stat };
    }
    throw error;
  }
}

// Walk parents until `.git` or the jail root. A worktree's `.git` file counts;
// anything outside the jail does not.
function findGitRoot(start) {
  let current = start;
  while (resolvedPathWithinRoot(current)) {
    try {
      const stat = fs.statSync(path.join(current, ".git"));
      if (stat.isDirectory() || stat.isFile()) return current;
    } catch {
      // Keep walking. A missing `.git` is the normal case for a plain folder.
    }
    if (current === workspaceBrowseRoot) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

// Fixed argument lists only. `repo` and any pathspec are realpaths already
// checked against the jail, and git is never invoked through a shell.
function runGit(repo, args) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-optional-locks", "-C", repo, ...args],
      {
        timeout: gitTimeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "",
        },
      },
      (error, stdout) => {
        if (!error) {
          resolve({ ok: true, stdout: stdout || "", timedOut: false });
          return;
        }
        resolve({
          ok: false,
          stdout: stdout || "",
          timedOut: Boolean(error.killed) || error.code === "ETIMEDOUT",
        });
      },
    );
  });
}

function gitTimeout() {
  return Object.assign(new Error("git status timed out"), { status: 503 });
}

function sumNumstat(stdout) {
  let added = 0;
  let deleted = 0;
  let binary = false;
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [addedField, deletedField] = line.split("\t");
    if (addedField === "-" || deletedField === "-") {
      binary = true;
      continue;
    }
    const additions = Number(addedField);
    const deletions = Number(deletedField);
    if (Number.isSafeInteger(additions)) added += additions;
    if (Number.isSafeInteger(deletions)) deleted += deletions;
  }
  return { added, deleted, binary };
}

// `git status --porcelain -z`: "XY path\0", and a rename's new path is its own
// record. Only untracked paths are returned; tracked edits come from numstat.
function porcelainUntracked(stdout) {
  const records = stdout.split("\0");
  const paths = [];
  let index = 0;
  while (index < records.length) {
    const record = records[index];
    if (!record) break;
    const code = record.slice(0, 2);
    if (code.startsWith("R") || code.startsWith("C")) {
      index += 2;
      continue;
    }
    if (code === "??") paths.push(record.slice(3));
    index += 1;
  }
  return paths;
}

function textLineCount(filePath, size, maxBytes) {
  if (size > maxBytes) return { lines: null, binary: false };
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    if (size === 0) return { lines: 0, binary: false };
    const buf = Buffer.alloc(size);
    const read = fs.readSync(fd, buf, 0, size, 0);
    if (read === 0) return { lines: 0, binary: false };
    let lines = 0;
    for (let i = 0; i < read; i++) {
      if (buf[i] === 0) return { lines: 0, binary: true };
      if (buf[i] === 10) lines += 1;
    }
    if (buf[read - 1] !== 10) lines += 1;
    return { lines, binary: false };
  } catch {
    return { lines: null, binary: false };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function containedFile(repo, relativePath) {
  const absolute = path.resolve(repo, relativePath);
  let resolved;
  try {
    resolved = fs.realpathSync(absolute);
  } catch {
    return null;
  }
  if (!resolvedPathWithinRoot(resolved)) return null;
  if (isReadDeniedName(path.basename(resolved))) return null;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    return { path: resolved, stat };
  } catch {
    return null;
  }
}

async function branchName(repo) {
  const current = await runGit(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.timedOut) throw gitTimeout();
  let name = current.ok ? current.stdout.trim() : "";
  let detached = false;
  if (!current.ok || !name || name === "HEAD") {
    const symbolic = await runGit(repo, ["symbolic-ref", "--short", "HEAD"]);
    if (symbolic.timedOut) throw gitTimeout();
    if (symbolic.ok && symbolic.stdout.trim()) {
      name = symbolic.stdout.trim();
    } else {
      const sha = await runGit(repo, ["rev-parse", "--short=7", "HEAD"]);
      if (sha.timedOut) throw gitTimeout();
      if (!sha.ok || !sha.stdout.trim()) return null;
      name = sha.stdout.trim();
      detached = true;
    }
  }
  return { branch: name.slice(0, 200), detached };
}

// GET /v1/codex/fs/git?path=
// `{ git:false }` when the path is not inside a repository. A file also carries
// `size` and `modifiedAt` so a client can tell a quiet poll from a save.
export async function fsGitStatus(searchParams) {
  const target = resolveGitTarget(searchParams.get("path") ?? "");
  if (target.kind === "file" && isReadDeniedName(path.basename(target.path))) {
    throw Object.assign(new Error("file matches the read denylist"), { status: 403 });
  }

  const start = target.kind === "file" ? path.dirname(target.path) : target.path;
  const repo = findGitRoot(start);
  if (!repo) return { git: false };

  const named = await branchName(repo);
  if (!named) return { git: false };

  const diff = await runGit(repo, ["diff", "--numstat", "HEAD", "--", target.path]);
  if (diff.timedOut) throw gitTimeout();
  const numstat = diff.ok ? sumNumstat(diff.stdout) : { added: 0, deleted: 0, binary: false };

  const status = await runGit(repo, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
    "--",
    target.path,
  ]);
  if (status.timedOut) throw gitTimeout();
  const untracked = status.ok ? porcelainUntracked(status.stdout) : [];

  let added = numstat.added;
  let deleted = numstat.deleted;
  let binary = target.kind === "file" && numstat.binary;

  if (target.kind === "file" && untracked.length > 0) {
    const counted = textLineCount(target.path, target.stat.size, fileUntrackedByteCap);
    added = counted.lines ?? 0;
    deleted = 0;
    binary = counted.binary;
  } else if (target.kind === "dir") {
    let countedFiles = 0;
    for (const relative of untracked) {
      if (countedFiles >= directoryUntrackedFileCap) break;
      const file = containedFile(repo, relative);
      if (!file) continue;
      const counted = textLineCount(file.path, file.stat.size, directoryUntrackedByteCap);
      if (counted.binary || counted.lines == null) continue;
      added += counted.lines;
      countedFiles += 1;
    }
  }

  const payload = {
    git: true,
    branch: named.branch,
    detached: named.detached,
    added,
    deleted,
    binary,
  };
  if (target.kind === "file") {
    payload.size = target.stat.size;
    payload.modifiedAt = target.stat.mtime.toISOString();
  }
  return payload;
}
