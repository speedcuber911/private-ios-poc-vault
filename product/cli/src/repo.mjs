// Git facts the handoff needs, and the guard that keeps `relay` inside a
// GitHub-backed repository. GitHub is the transport for repo state, so a repo
// without a github.com origin cannot be handed off at all — say so early.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Host match is case-insensitive (hostnames are); the `i` flag also makes the
// literal "git@github.com:" and "ssh://git@github.com" alternatives
// case-insensitive, which is correct for the same reason. The owner/repo
// capture groups are matched with `[^/]+` (never `.` — a segment must not be
// able to swallow a "/"), and are returned exactly as GitHub gave them: this
// module must not silently fold "Me/Relay" and "me/relay" into different
// identifiers than the ones GitHub itself uses.
const GITHUB_REMOTE_RE = /^(?:https?:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/|git:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([^/]+)\/([^/]+?)(?:\.git)?$/i;

// Any URI-style scheme other than `file://` is a network transport, not a
// local path — reject it outright, even under RELAY_ALLOW_LOCAL_REMOTE.
const NETWORK_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
// Git's scp-like shorthand, `[user@]host:path` (e.g. "git@gitlab.com:me/x.git"
// or "gitlab.com:me/x.git") — also a network remote. Matched only when the
// colon is NOT immediately followed by "//" (that shape is already caught by
// NETWORK_SCHEME_RE above) and the segment before it contains no "/", so an
// absolute path like "/tmp/some-repo.git" can never match here.
const SCP_LIKE_RE = /^(?:[^@\s/]+@)?[^\s/:]+:(?!\/\/)/;

function parseGitHubRemote(url) {
  const match = GITHUB_REMOTE_RE.exec(String(url || "").trim());
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

// RELAY_ALLOW_LOCAL_REMOTE exists solely so the test suite can point `origin`
// at a `file://` URL or a bare local path instead of a real github.com
// remote. It must never become a way to point `relay handoff` — which pushes
// the user's branch and working tree to whatever `origin` resolves to — at
// an arbitrary network host. Every non-file:// scheme and every scp-like
// `user@host:path` form is rejected before it ever reaches path.basename.
function parseLocalRemote(url) {
  const raw = String(url || "").trim();
  if (!raw) return null;

  const scheme = NETWORK_SCHEME_RE.exec(raw);
  if (scheme) {
    if (scheme[1].toLowerCase() !== "file") return null;
  } else if (SCP_LIKE_RE.test(raw)) {
    return null;
  }

  const cleaned = raw.replace(/^file:\/\//i, "").replace(/\.git$/, "");
  // A canonical absolute local path starts with exactly one "/". Two or more
  // is a UNC network path on Windows/Cygwin git ("//host/share/...") even
  // though macOS/Linux git happens to resolve it locally — RELAY_ALLOW_LOCAL_
  // REMOTE is a test-only bypass and must not accept a shape that is a
  // network remote on any platform relay might run on.
  if (!cleaned.startsWith("/") || cleaned.startsWith("//")) return null;
  return `local/${path.basename(cleaned).toLowerCase()}`;
}

async function git(root, args, execFileImpl = execFileAsync) {
  const { stdout } = await execFileImpl("git", ["-C", root, ...args], { maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

// Bounds the work workingTreeSummary will do counting untracked lines: a
// repo with an untracked `node_modules` (30k-100k files — exactly the "quick
// experiment, no .gitignore yet" repo a handoff targets) must not turn the
// shut-the-laptop command into a multi-minute wait. Past the cap, files are
// still counted toward `files`/the summary's file total; only their line
// counts stop being added to `insertions`, and the summary says so.
const MAX_UNTRACKED_FILES_COUNTED = 2000;
const UNTRACKED_STREAM_CHUNK_BYTES = 64 * 1024;
const UNTRACKED_STREAM_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

// Counts newline-terminated lines in a file without ever holding more than
// one fixed-size chunk of it in memory. This replaces a design that spawned
// one `git diff --no-index` subprocess per untracked file (~5.2ms each,
// serially — 26s at 5,000 files) to solve an earlier, narrower problem (a
// single very large untracked file driving a multi-hundred-MB heap spike from
// `fs.readFileSync`). Counting in-process with a bounded buffer solves both:
// no subprocess per file, and no whole-file string in the JS heap either.
// O_NONBLOCK is defence in depth, not the primary guard — every call site
// stats the entry and skips anything that is not `isFile()` before this is
// ever reached — but it turns a FIFO that slips through a future TOCTOU race
// into an immediate ENXIO/EAGAIN instead of a blocked open, matching the same
// pattern already used for session transcripts in sessions.mjs. A trailing
// line with no final "\n" still counts as one line, matching how `git diff
// --numstat` counts a new file's last, unterminated line.
function countFileLines(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, UNTRACKED_STREAM_FLAGS);
  } catch {
    return 0;
  }
  try {
    const buffer = Buffer.alloc(UNTRACKED_STREAM_CHUNK_BYTES);
    let lines = 0;
    let sawAnyByte = false;
    let endedWithNewline = true;
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      sawAnyByte = true;
      for (let i = 0; i < bytesRead; i += 1) {
        if (buffer[i] === 0x0a) lines += 1;
      }
      endedWithNewline = buffer[bytesRead - 1] === 0x0a;
    }
    if (sawAnyByte && !endedWithNewline) lines += 1;
    return lines;
  } catch {
    return 0;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or never fully opened; nothing more to do.
    }
  }
}

async function requireGitHubRepo({ cwd = process.cwd(), execFileImpl = execFileAsync } = {}) {
  let root;
  try {
    const { stdout } = await execFileImpl("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
    root = stdout.trim();
  } catch {
    throw new Error("not_a_git_repo: run relay inside a git repository");
  }

  let remote;
  try {
    remote = (await git(root, ["remote", "get-url", "origin"], execFileImpl)).trim();
  } catch {
    throw new Error("no_origin_remote: this repository has no origin remote");
  }

  const fullName = parseGitHubRemote(remote)
    || (process.env.RELAY_ALLOW_LOCAL_REMOTE === "1" ? parseLocalRemote(remote) : null);
  if (!fullName) throw new Error("origin_not_github: relay handoff needs a github.com origin");

  return { root, fullName, remote, branch: await currentBranch({ root, execFileImpl }) };
}

async function currentBranch({ root, execFileImpl = execFileAsync }) {
  try {
    return (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], execFileImpl)).trim();
  } catch (err) {
    // An unborn branch (a repository with zero commits) makes `rev-parse
    // --abbrev-ref HEAD` fail with a raw "ambiguous argument 'HEAD'" — the
    // one shape of this failure that has a known cause, so it gets a named
    // error. Anything else (a corrupt repo, git missing, ...) is a real
    // fatal error and is left to surface unmodified.
    const detail = `${err?.stderr || ""} ${err?.message || ""}`;
    if (/ambiguous argument 'HEAD'|unknown revision or path not in the working tree/i.test(detail)) {
      throw new Error("unborn_branch: this repository has no commits yet");
    }
    throw err;
  }
}

// Parses one `git status --porcelain -z` NUL-separated stream into entries.
// -z is not just a separator choice: without it, git C-quotes any path with
// a non-ASCII or control byte (e.g. "café.txt" -> "\"caf\\303\\251.txt\""),
// and naively re-joining that against the filesystem points at a path that
// never existed. -z never quotes. A staged rename/copy record additionally
// carries one extra NUL-terminated token (the original path) right after it,
// which is not itself a changed entry and must be skipped, not counted.
function parsePorcelainZ(raw) {
  const tokens = raw.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

  const entries = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const status = token.slice(0, 2);
    entries.push({ status, path: token.slice(3) });
    if (status[0] === "R" || status[0] === "C") i += 1; // skip the paired original-path token
  }
  return entries;
}

async function workingTreeSummary({ root, execFileImpl = execFileAsync }) {
  // --untracked-files=all expands a brand-new untracked directory into its
  // individual files instead of collapsing it into one "?? newdir/" entry —
  // otherwise 20 new files in a new directory would be reported as 1 file.
  const raw = await git(root, ["status", "--porcelain", "-z", "--untracked-files=all"], execFileImpl);
  const entries = parsePorcelainZ(raw);
  if (entries.length === 0) return { files: 0, insertions: 0, deletions: 0, summary: "no uncommitted changes" };

  let insertions = 0;
  let deletions = 0;

  // Diffing straight against HEAD (not --cached) captures staged AND
  // unstaged changes in the same pass — the same universe of content that
  // `read-tree HEAD; add -A` actually ships in a handoff commit. A
  // `--cached`-only or working-tree-only diff would under-report a file the
  // user has already `git add`ed.
  const numstat = (await git(root, ["diff", "--numstat", "HEAD"], execFileImpl)).trim();
  for (const line of numstat ? numstat.split("\n") : []) {
    const [added, removed] = line.split("\t");
    insertions += Number.parseInt(added, 10) || 0;
    deletions += Number.parseInt(removed, 10) || 0;
  }

  // Untracked files never appear in `git diff`, staged or not, so their line
  // counts are collected separately, in-process (countFileLines), never by
  // spawning a subprocess per file and never by loading a whole file into a
  // JS string. Two guards run before any file is opened:
  //   1. fs.statSync (unlike lstatSync) follows a symlink entry to its
  //      ultimate target and skips anything that is not a plain file — a
  //      symlink to a FIFO, a socket, or a device would otherwise be opened
  //      and, for a FIFO with no writer, block forever with no way to
  //      interrupt it from JS (the same class the session-discovery FIFO fix
  //      already closed). ENOENT (a dangling target) is swallowed by
  //      throwIfNoEntry; every other failure, most notably ELOOP from a
  //      symlink loop, is caught explicitly. Skipped entries contribute 0,
  //      same as any other unreadable entry already did.
  //   2. MAX_UNTRACKED_FILES_COUNTED caps how many files get opened at all,
  //      so an untracked `node_modules` (30k-100k files) cannot turn this
  //      into a multi-minute wait even at in-process speed. Truncation is
  //      reported in the summary, not silently dropped.
  let untrackedCounted = 0;
  let untrackedTruncated = false;
  for (const entry of entries) {
    if (entry.status !== "??") continue;
    const untracked = path.join(root, entry.path);

    let stat;
    try {
      stat = fs.statSync(untracked, { throwIfNoEntry: false });
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) continue;

    if (untrackedCounted >= MAX_UNTRACKED_FILES_COUNTED) {
      untrackedTruncated = true;
      continue;
    }
    untrackedCounted += 1;
    insertions += countFileLines(untracked);
  }

  const files = entries.length;
  const noun = files === 1 ? "file" : "files";
  let summary = `${files} ${noun} changed, +${insertions}/-${deletions}`;
  if (untrackedTruncated) {
    summary += ` (line counts capped at ${MAX_UNTRACKED_FILES_COUNTED} untracked files; totals may undercount)`;
  }
  return { files, insertions, deletions, summary, truncated: untrackedTruncated };
}

export { requireGitHubRepo, parseGitHubRemote, currentBranch, workingTreeSummary, git, MAX_UNTRACKED_FILES_COUNTED };
