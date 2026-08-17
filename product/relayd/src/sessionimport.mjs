// relayd sessionimport.mjs — stage a handed-off session so the harness's own
// resume mechanism continues the conversation on this node.
//
// Claude Code keys sessions by the absolute working directory; Codex replays a
// rollout by id but records the working directory in the rollout's
// `session_meta` line. BOTH are rewritten from the laptop path to the sandbox
// checkout, for two reasons that apply equally to both formats: relayd's own
// resume gate (`threads.resumeMetaBelongsToWorkspace`, reached from
// `jobs.createJob`) resolves that recorded cwd and refuses 400 `session does
// not belong to workspace` when it names a directory that does not exist here,
// and an un-rewritten laptop path carries the user's real username into the
// sandbox — the exact leak the PATH_TERMINATOR/CWD_BOUNDARY apparatus below
// exists to prevent. An earlier version of this header said Codex "needs no
// rewriting"; that was true of Codex's own resume mechanism and false of
// everything downstream of it, and it is why Continue was broken for every
// Codex handoff. Cursor has no portable session file, so it takes the
// primed-prompt path — stated plainly rather than faked.
//
// ---------------------------------------------------------------------------
// THREAT MODEL — read this before changing anything below.
//
// This module runs inside the user's sandbox and stages a transcript that
// arrived over a handoff transfer from their laptop. `manifest` is
// REMOTE-SUPPLIED DATA: every field is attacker-controlled. The coding agent
// that shares this sandbox owns its own HOME, runs concurrently with relayd,
// and can therefore pre-plant symlinks, hard links and directories anywhere
// under the staging tree, and can swap them while we work.
//
// The property this module must hold — not a list of patched CVEs, the
// property — is:
//
//   No write performed by this module may land outside the jail by ANY
//   filesystem mechanism (symlink at any path component, hard link, race, or
//   directory creation), and no failure of that guarantee may be silent.
//
// "Write" here is precise and is defined exactly in the RESIDUAL section
// below, because a fourth round of this module already shipped an inaccurate
// version of that sentence ("leaves nothing outside the jail", "residue
// unwound") that a reviewer's two-window race falsified. Read RESIDUAL before
// trusting any summary of what this module guarantees, including this one.
//
// Three previous rounds tried to hold it by bolting a check onto a
// path-then-write sequence, and each round left a different mechanism open
// (unsanitised id -> lexical check; symlinked leaf -> O_NOFOLLOW; symlinked
// intermediate/hard link/race -> nothing). Path-based checks cannot hold the
// property, because every fs call re-resolves the path from `/` and the check
// and the write are therefore looking at two different filesystems.
//
// So the staging path is not checked, it is CONSTRUCTED, one component at a
// time, and the content write never touches a name an attacker could have
// pre-placed:
//
//   1. The jail root is resolved to a realpath ONCE (`resolveJailRoot`). It is
//      caller-supplied, not manifest-supplied — the one path here that is not
//      attacker data.
//   2. Every component below it is created with a NON-recursive `mkdirSync`
//      (which never creates anything through a symlink) and then re-opened with
//      O_DIRECTORY|O_NOFOLLOW (which refuses a symlink outright), so a
//      symlinked `.claude`, `projects`, `<slug>` or `sessions` fails closed
//      BEFORE any directory is created outside the jail. This is also what
//      makes the containment check bite on escapes that stay *inside* the
//      home directory (sibling-workspace transcript poisoning): every
//      component is pinned individually, so there is no "jail root" width to
//      get wrong.
//   3. The content is written to a file we created ourselves under a
//      128-bit-random name with O_CREAT|O_EXCL|O_NOFOLLOW — never directly to
//      its final transcript/rollout name, which an attacker may have pre-planted
//      as a symlink or a HARD LINK (a hard link has no link-ness to detect at
//      the path level, and O_NOFOLLOW does not see it). There is no O_TRUNC
//      anywhere: nothing is destroyed before it has been validated.
//   4. Once that fd is open we stop using paths for the write: the fd names an
//      inode, so no later swap can redirect the bytes. Identity, regular-file
//      -ness, nlink and location are checked on the fd, before AND after the
//      write.
//   5. The file is moved into place with `rename`, which replaces the
//      destination directory entry rather than writing through it — so even a
//      symlink or hard link planted at the leaf in the microsecond before the
//      rename receives nothing.
//
// RESIDUAL, stated rather than hidden: Node exposes no *at() syscalls
// (`openat`, `mkdirat`, `renameat`), so steps 2, 3 and 5 still name their
// parent by path and are not formally atomic. What is left is a race an
// attacker wins only by swapping a directory component inside the window
// between our O_DIRECTORY|O_NOFOLLOW verification and the very next syscall.
// The exact guarantee that survives that race — no more, no less, and
// deliberately not rounded up to something tidier:
//
//   - No EXISTING file is ever overwritten or truncated. O_EXCL means this
//     module can only ever CREATE a new inode, and O_TRUNC appears nowhere
//     in it.
//   - No SESSION CONTENT ever reaches a file outside the jail. Immediately
//     before the content write (see writeStagedFile), the staged fd's own
//     link count is re-checked with NO fs call in between that check and the
//     write itself. That is what actually stops the two-window attack —
//     swap the staging directory for a symlink out of the jail, let the
//     O_CREAT land outside, hard-link the new (still empty) file back into
//     the restored real directory, restore the directory — because that
//     attack defeats every PATH-based check in this sequence (the swapped
//     directory resolves back to a real, in-jail-looking path by the time
//     they run) but cannot defeat an fd-based nlink check with nothing for
//     the attacker to act between: fstat(fd) reads live kernel state, so a
//     hard link created at ANY earlier point is already visible here.
//   - What this module cannot always prevent: a lost race can still leave an
//     EMPTY file (0 bytes, created by this module, never written to)
//     outside the jail, because the O_CREAT that makes it is still named by
//     a path. When that happens, this module's only handle on the file is
//     the in-jail name it was given; if a race severs that name from the
//     inode before cleanup runs, cleanup cannot find it (see
//     removeStagingFile) and the empty file is left behind. This is a
//     hygiene residue, not a confidentiality one — the file carries no
//     session content and never did.
//   - Every one of the above — the ones this module prevents and the one it
//     cannot fully unwind — ends in a thrown `SessionImportSecurityError`
//     with a pinned `code`, never a raw fs error and never silently.
//
// Closing the empty-file residue completely needs a native `openat` binding
// (so the create, every verification and the write are one fd from the
// start, never a second path resolution), which the zero-dependency
// constraint rules out.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// The ONE definition of a resumable session id, shared with `isSafeJobId` and
// therefore with `threads.cleanOptionalSessionId` — the validator that used to
// disagree with this module's own and made every Codex handoff unresumable.
// sessionid.mjs is deliberately dependency-free so importing it here does not
// drag relayd's runtime configuration into this jail module.
import { isResumableSessionId } from "./sessionid.mjs";

const HANDOFF_MANIFEST_VERSION = 1;

// A rewritten transcript is bounded so a hostile manifest cannot turn a small
// upload into a multi-hundred-megabyte allocation (see rewriteSessionCwd).
const MAX_REWRITTEN_BYTES = 256 * 1024 * 1024;

// Every refusal in this module is this one class, with a machine-readable
// `code`. Two reasons it is not a bare Error: a caller (or a test) must be
// able to tell "we refused" from "we crashed" — a bare `assert.throws` passes
// on an unrelated TypeError, which is how a broken guard survived a previous
// round — and the message must never carry an absolute path or an untruncated
// slab of attacker input into a log. Wrapped fs errors keep the original on
// `cause`, where it stays available to a debugger without being formatted into
// the message.
class SessionImportSecurityError extends Error {
  constructor(code, detail, options) {
    super(`${code}: ${detail}`, options);
    this.name = "SessionImportSecurityError";
    this.code = code;
  }
}

const refuse = (code, detail, cause) =>
  new SessionImportSecurityError(code, detail, cause ? { cause } : undefined);

// Node's fs errors embed the full absolute path ("ELOOP: ... open '/srv/…'").
// Keep the errno, drop the path.
const wrapFsError = (code, detail, err) =>
  refuse(code, `${detail} (${err?.code || "unknown"})`, err);

// Runs a single raw `fs` call and turns ANY failure it produces into a typed
// `SessionImportSecurityError`. This exists because several `fs` calls in the
// staging/verification path used to be unwrapped: reachable with no race at
// all (an ordinary ENOSPC or EIO from a real disk hits any of them), and each
// one that fired surfaced as a bare `Error` with an absolute host path in its
// message — falsifying the "every refusal is typed, no absolute path ever
// reaches a message" contract on a path a real deployment will actually hit.
// A `SessionImportSecurityError` thrown by the callback (one of this
// module's own refusals, e.g. a nlink/identity check) passes straight
// through unwrapped — this only ever touches genuinely raw fs errors.
function guarded(code, detail, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof SessionImportSecurityError) throw err;
    throw wrapFsError(code, detail, err);
  }
}

// The id is echoed back so an operator can see what was rejected, but it is
// attacker-controlled and can be 4 KB long, so it is clipped first.
function redactUntrusted(value) {
  const text = typeof value === "string" ? value : Object.prototype.toString.call(value);
  const clipped = text.length > 48 ? `${text.slice(0, 48)}...(+${text.length - 48} more)` : text;
  return JSON.stringify(clipped);
}

// `manifest.sessionId` crossed a machine boundary, so it is untrusted input:
// reject anything that is not a resumable session id before it ever touches a
// filesystem path.
//
// This used to be a LOCAL allow-list (`^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`)
// that was ~100 characters more permissive than the one `createJob` applies to
// the very same value moments later, so this module cheerfully staged ids that
// could never be resumed. It now defers to the single shared contract in
// sessionid.mjs, which makes "staged here" and "resumable there" the same set.
//
// That is a NARROWING, never a widening: the shared predicate is 36 lowercase
// hex-or-dash characters, so it already excludes — by construction, not by a
// second check bolted on top — `..`, `/`, `\`, NUL, newline, a leading `.`,
// every non-ASCII byte, and anything longer than 36 bytes. The traversal tests
// below assert exactly that, on both branches.
function assertSafeSessionId(sessionId) {
  if (!isResumableSessionId(sessionId)) {
    throw refuse("unsafe_session_id", redactUntrusted(sessionId));
  }
  return sessionId;
}

// Codex app-server does not discover an arbitrary `<threadId>.jsonl` file.
// Its native session store uses `rollout-<timestamp>-<threadId>.jsonl`; resume
// by UUID returns `no rollout found` when the same valid bytes are staged under
// the bare id. The timestamp is only a discovery filename component, so use the
// sealed handoff's creation time and fall back deterministically when absent.
// Every byte of the returned leaf is constructed here from fixed punctuation,
// a normalized ISO date, and the already allow-listed session id.
function codexRolloutLeafName(sessionId, createdAt = null) {
  const safeSessionId = assertSafeSessionId(sessionId);
  const date = new Date(createdAt ?? 0);
  const normalized = Number.isFinite(date.getTime()) ? date : new Date(0);
  const timestamp = normalized.toISOString().slice(0, 19).replaceAll(":", "-");
  return `rollout-${timestamp}-${safeSessionId}.jsonl`;
}

const MAX_REPAIR_ROLLOUT_BYTES = 20 * 1024 * 1024;

// Read an already-staged rollout through a pinned descriptor. This is only for
// migrating the old `<threadId>.jsonl` layout; new imports always go through
// writeStagedFile below. Missing files are ordinary (there may be no legacy
// handoff), while every unsafe or unbounded shape fails closed.
function readExistingRollout(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw wrapFsError("legacy_rollout_open_failed", "cannot open the staged Codex rollout", err);
  }

  try {
    const before = guarded("legacy_rollout_verify_failed", "cannot verify the staged Codex rollout", () => fs.fstatSync(fd));
    if (!before.isFile() || before.nlink !== 1) {
      throw refuse("legacy_rollout_unsafe", "the staged Codex rollout is not a private regular file");
    }
    if (before.size > MAX_REPAIR_ROLLOUT_BYTES) {
      throw refuse("legacy_rollout_too_large", "the staged Codex rollout is too large to migrate");
    }
    const contents = guarded("legacy_rollout_read_failed", "cannot read the staged Codex rollout", () => fs.readFileSync(fd));
    const after = guarded("legacy_rollout_verify_failed", "cannot re-verify the staged Codex rollout", () => fs.fstatSync(fd));
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 || after.size !== contents.length) {
      throw refuse("legacy_rollout_race", "the staged Codex rollout changed while it was read");
    }
    return contents;
  } finally {
    try { fs.closeSync(fd); } catch { /* fd is ours; nothing more to do */ }
  }
}

function rolloutDeclaresSessionId(contents, sessionId) {
  const prefix = contents.subarray(0, Math.min(contents.length, 256 * 1024)).toString("utf8");
  for (const line of prefix.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "session_meta") return entry.payload?.id === sessionId;
    } catch {
      // A partial line at the bounded-read edge is expected; keep looking.
    }
  }
  return false;
}

// Handoffs imported before the native-filename fix may already be `ready`
// with `<CODEX_HOME>/sessions/<threadId>.jsonl`. Ready imports are idempotent,
// so redeploying alone would never restage them. Continue calls this once to
// publish the same validated bytes under Codex's discoverable rollout name.
// The legacy file is deliberately retained as a recoverable fallback.
function repairLegacyCodexRollout({ codexHome, sessionId, createdAt = null }) {
  const safeSessionId = assertSafeSessionId(sessionId);
  const realRoot = resolveJailRoot(codexHome);
  const sessionsDir = buildStagingDir(realRoot, ["sessions"]);
  const nativeName = codexRolloutLeafName(safeSessionId, createdAt);
  const nativePath = path.join(sessionsDir, nativeName);
  const existingNative = readExistingRollout(nativePath);
  if (existingNative) {
    if (!rolloutDeclaresSessionId(existingNative, safeSessionId)) {
      throw refuse("legacy_rollout_mismatch", "the native Codex rollout declares a different session id");
    }
    return nativePath;
  }

  const legacyPath = path.join(sessionsDir, `${safeSessionId}.jsonl`);
  const legacyBytes = readExistingRollout(legacyPath);
  if (!legacyBytes) return null;
  if (!rolloutDeclaresSessionId(legacyBytes, safeSessionId)) {
    throw refuse("legacy_rollout_mismatch", "the legacy Codex rollout declares a different session id");
  }

  return stageSessionFile({
    jailRoot: realRoot,
    components: ["sessions"],
    leafName: nativeName,
    contents: legacyBytes,
  });
}

// A single path component we are about to create. `.claude`/`projects`/
// `sessions` are literals, and `claudeProjectSlug` can only emit
// [A-Za-z0-9-] for a NON-EMPTY cwd — but it can fire today: an empty
// `worktreePath` makes `claudeProjectSlug("") === ""`, and an empty
// component here is refused rather than silently descending one level too
// few (which would stage the transcript at `projects/<id>.jsonl` instead of
// `projects/<slug>/<id>.jsonl` — still inside the jail, so not an escape,
// but wrong). Covered directly by a test, not just assumed.
function assertSafeComponent(component, position) {
  if (
    typeof component !== "string" ||
    component === "" ||
    component === "." ||
    component === ".." ||
    component.includes("/") ||
    component.includes("\\") ||
    component.includes("\0")
  ) {
    throw refuse("unsafe_path_component", `staging path component ${position} is not a single safe name`);
  }
  return component;
}

// A lexical containment check: resolves both paths (never touches the
// filesystem) and requires the file to be `base` itself or a genuine child of
// it. Compares against `base + path.sep` rather than a bare startsWith(base),
// so a sibling directory that merely shares a prefix (e.g. base "/srv/relay"
// vs "/srv/relay-evil") cannot pass. Exported and directly unit-tested below.
//
// Honest note on the one call site in this module (inside stageSessionFile):
// `leafName` is either `${sessionId}.jsonl` or the value returned by
// `codexRolloutLeafName`; both are constructed from a session id already
// through `assertSafeSessionId`'s allow-list. The joined path is therefore
// provably always a child of `stagingDir` — that call can never actually
// refuse anything (confirmed by mutation testing: deleting it leaves the suite
// green). It is not a "layer of defense" there; the per-component descent in
// buildStagingDir/ensureRealChildDir is what actually holds the jail. The call
// is kept so this exported helper has a call site inside the module, should a
// future change to leafName construction make the check meaningful again.
function assertContained(baseDir, filePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
    throw refuse("unsafe_session_id", "resolved path escapes base directory");
  }
  return resolvedFile;
}

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

// Characters that END a path in a transcript rather than continue a filename:
// the separator, the quoting characters JSON and shells use, whitespace, and
// ordinary prose/shell punctuation. A coding-agent transcript is mostly stack
// traces ("path:12:3"), grep output, shell lines ("cd path; ls") and prose
// ("see path, then run") — a boundary class that does not terminate on `,`,
// `)`, `:` or `;` leaks the laptop absolute path, which contains the user's
// real username, into the sandbox.
//
// This is an UNDECIDABLE problem, resolved deliberately rather than by
// accident: on POSIX every byte except `/` and NUL is legal in a filename, so
// "the path, then punctuation" and "a sibling directory whose name starts with
// punctuation" are indistinguishable from the text alone. The trade-off taken
// here is: terminate on characters that a real sibling name essentially never
// STARTS with (closing brackets, prose punctuation, shell operators), and do
// not terminate on characters that real sibling names routinely start with
// (`-` in "relay-old", `+` in "relay+plus", `~` in "relay~1", `(` in
// "relay(copy)", `@` in "relay@2", `.` in "relay.bak", `#` in "relay#3", and
// of course alphanumerics), nor on `$` (a transcript showing shell-style
// concatenation directly after the path — "${FROM_CWD}$SUFFIX" — is at least
// as plausible as a sibling name starting with `$`, and splitting that
// concatenation would be a worse mistake than leaking it, so `$` is left as a
// deliberate, documented leak alongside `(`, `#` and `@` above). Redacting the
// laptop path is weighted above preserving a pathological sibling name,
// because the leak is a real privacy regression and the sibling is at worst a
// corrupted line in the attacker's own transcript — which is also why `*`,
// `%` and `^` (a shell glob, a URL-encoded byte, a shell job-control
// operator — none of them a plausible way for a real sibling NAME to START)
// DO terminate below, even though round 4 left them unlisted.
const PATH_TERMINATOR = String.raw`[/"'\\\s\x60,;:!?=|&>)\]}*%^]`;
// ...plus a run of periods that is itself followed by a terminator or the end
// of the line, so "working in /path/to/relay." and "…/relay... and then" are
// rewritten while the sibling "/path/to/relay.bak" is not.
//
// Note on `m` below: the previous round's class ended in `\.?$` WITHOUT `m`,
// so on the multi-line JSONL that is the only real input, the trailing-period
// clause was dead code and the single-line test that "proved" it was asserting
// a behaviour that did not exist. Here the newline is caught by `\s` in the
// terminator class, so end-of-line already works; `m` is kept so the `$`
// clauses keep meaning end-of-LINE if that class is ever narrowed, and the
// test for this case is deliberately written on multi-line input.
const CWD_BOUNDARY = String.raw`(?=${PATH_TERMINATOR}|\.+(?:${PATH_TERMINATOR}|$)|$)`;

// Named for what it does, not for one of its two callers: it retargets an
// absolute cwd inside a transcript, and BOTH the Claude and the Codex branch
// need that (see the module header). It was called `rewriteClaudeSession` while
// the Codex branch skipped it entirely, which is how the laptop path kept
// reaching the sandbox in a rollout.
function rewriteSessionCwd(text, { fromCwd, toCwd }) {
  if (fromCwd === undefined || fromCwd === null || fromCwd === "") return text;
  // Every other untrusted manifest field gets a typed, named rejection; this
  // one used to reach `.replace()` unchecked and die with a raw TypeError a
  // caller could not tell from a bug.
  if (typeof fromCwd !== "string") {
    throw refuse("unsafe_manifest_cwd", `manifest.cwd must be a string, got ${typeof fromCwd}`);
  }
  if (typeof toCwd !== "string") {
    throw refuse("unsafe_worktree_path", `worktreePath must be a string, got ${typeof toCwd}`);
  }
  if (fromCwd === toCwd) return text;
  // A one-character "cwd" is not a cwd, and substituting it would rewrite every
  // occurrence of that character in the transcript — a 58x memory amplifier
  // measured on a hostile manifest. Nothing legitimate is lost: no real
  // absolute cwd is shorter than two characters.
  if (fromCwd.length < 2) return text;
  // O(1) upper bound on the output size (every possible match, at maximum
  // growth) so a hostile fromCwd/toCwd pair is refused before the allocation
  // rather than after it.
  const maxMatches = Math.floor(text.length / fromCwd.length);
  const projected = text.length + maxMatches * Math.max(0, toCwd.length - fromCwd.length);
  if (projected > MAX_REWRITTEN_BYTES) {
    throw refuse("session_rewrite_too_large", `rewrite could expand to ${projected} bytes`);
  }
  const escaped = fromCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The replacement is a function, not a string: String.prototype.replace
  // gives $&, $`, $', $1... special meaning in a *string* replacement, so a
  // toCwd containing one of those sequences would get reinterpreted instead of
  // inserted literally. A function replacement is always used as-is. (The
  // caller in flight, handoff.mjs, sanitises the handoff id before it reaches
  // toCwd, so this is defence in depth rather than a live vector — but it is
  // unconditionally correct and free.)
  return text.replace(new RegExp(`${escaped}${CWD_BOUNDARY}`, "gm"), () => toCwd);
}

// ---------------------------------------------------------------------------
// The jail.

// The jail root is supplied by relayd itself, not by the manifest, so it is
// the one path in this module that is not attacker data — but it may not exist
// yet, and its final component must not be something the sandboxed agent
// swapped for a symlink to `/`. Resolve it exactly once; every later step is
// expressed relative to the resolved root, so a symlinked ANCESTOR (macOS
// /var -> /private/var, which every temp dir has) is handled correctly instead
// of being mistaken for an escape.
//
// What this cannot defend: a jail root whose own ancestors an attacker
// controls. That is a caller invariant, not something reachable from here.
function resolveJailRoot(jailRoot) {
  if (typeof jailRoot !== "string" || jailRoot === "") {
    throw refuse("unsafe_jail_root", "jail root must be a non-empty path");
  }
  try {
    fs.mkdirSync(jailRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (err?.code !== "EEXIST") throw wrapFsError("jail_root_unusable", "cannot create the jail root", err);
  }
  let stat;
  try {
    stat = fs.lstatSync(jailRoot);
  } catch (err) {
    throw wrapFsError("jail_root_unusable", "cannot stat the jail root", err);
  }
  if (stat.isSymbolicLink()) {
    throw refuse("jail_root_is_symlink", "the jail root itself is a symlink");
  }
  if (!stat.isDirectory()) {
    throw refuse("jail_root_not_a_directory", "the jail root is not a directory");
  }
  // Repair the root's own mode the same way every component below it is
  // repaired: through an O_NOFOLLOW fd, not the path. Without this, an
  // ADOPTED jail root — the common case, since relayd's own HOME already
  // exists on every real run — was accepted at whatever mode it already had
  // and never brought back to 0700, even though every level below it was.
  let rootFd;
  try {
    rootFd = fs.openSync(jailRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    throw wrapFsError("jail_root_unusable", "cannot open the jail root", err);
  }
  try {
    const rootStat = guarded("jail_verify_failed", "cannot verify the jail root", () => fs.fstatSync(rootFd));
    if ((rootStat.mode & 0o777) !== 0o700) {
      guarded("jail_staging_io_failed", "cannot repair the jail root's mode", () => fs.fchmodSync(rootFd, 0o700));
    }
  } finally {
    try { fs.closeSync(rootFd); } catch { /* fd is ours; nothing more to do */ }
  }
  try {
    return fs.realpathSync(jailRoot);
  } catch (err) {
    throw wrapFsError("jail_root_unusable", "cannot resolve the jail root", err);
  }
}

// Create (or adopt) exactly ONE directory level under an already-verified real
// parent, and prove it is a real directory inside that parent before returning.
//
// - `mkdirSync` WITHOUT `recursive` is the point: the recursive form walks
//   through symlinked intermediates and creates directories on the far side of
//   them before any check can fire. The non-recursive form creates a single
//   entry in `parentReal` or fails EEXIST; it never creates anything through a
//   symlink.
// - The subsequent open with O_DIRECTORY|O_NOFOLLOW is what rejects an
//   ADOPTED component: if `child` already exists as a symlink (pointing
//   outside the jail, or at a sibling workspace inside it), mkdir returns
//   EEXIST and the open returns ELOOP.
// - The mode is repaired through the fd (`fchmod`), not the path, so a
//   pre-planted world-readable directory is brought back to 0700 without a
//   second path resolution to race.
function ensureRealChildDir(parentReal, component, position, created) {
  const child = path.join(parentReal, assertSafeComponent(component, position));
  try {
    fs.mkdirSync(child, 0o700);
    created.push(child);
  } catch (err) {
    if (err?.code !== "EEXIST") {
      throw wrapFsError("jail_mkdir_failed", `cannot create staging path component ${position}`, err);
    }
  }
  let fd;
  try {
    fd = fs.openSync(child, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  } catch (err) {
    // O_NOFOLLOW over a symlink is ELOOP on Linux but ENOTDIR on macOS when
    // O_DIRECTORY is also set, and a symlink to a file is ENOTDIR everywhere.
    // Ask the filesystem what it actually is rather than inferring it from an
    // errno that differs per platform, so the refusal names the real cause.
    if (err?.code === "ELOOP" || err?.code === "EMLINK" || err?.code === "ENOTDIR") {
      let planted = null;
      try { planted = fs.lstatSync(child); } catch { /* raced away; treat as not-a-directory */ }
      if (!planted || planted.isSymbolicLink()) {
        throw refuse("jail_escape_symlinked_component", `staging path component ${position} is a symlink`, err);
      }
      throw refuse("jail_escape_not_a_directory", `staging path component ${position} is not a directory`, err);
    }
    throw wrapFsError("jail_open_dir_failed", `cannot open staging path component ${position}`, err);
  }
  try {
    const stat = guarded("jail_verify_failed", `cannot verify staging path component ${position}`, () => fs.fstatSync(fd));
    if (!stat.isDirectory()) {
      throw refuse("jail_escape_not_a_directory", `staging path component ${position} is not a directory`);
    }
    if ((stat.mode & 0o777) !== 0o700) {
      guarded("jail_staging_io_failed", `cannot repair the mode of staging path component ${position}`, () => fs.fchmodSync(fd, 0o700));
    }
  } finally {
    // Best-effort: release our own fd promptly. Must never replace whichever
    // error (typed refusal or otherwise) is already propagating out of this
    // block, and close(2) on an fd we just successfully used is not a
    // realistic failure mode worth its own typed code.
    try { fs.closeSync(fd); } catch { /* fd is ours; nothing more to do */ }
  }
  return child;
}

// If the descent fails part-way we may already have created directories, and
// under a lost race (a component swapped for a symlink between our
// verification of level N and our mkdir of level N+1) one of them can be on
// the far side of that symlink. Take them back out. Only directories THIS call
// created are touched, only if they are still real directories, and only if
// they are still empty — `rmdir` cannot destroy data, so the worst case of
// losing a second race during the unwind is removing an empty directory the
// attacker themselves just created.
function unwindCreatedDirs(created) {
  for (let index = created.length - 1; index >= 0; index -= 1) {
    const dir = created[index];
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory()) continue;
      // rmdir(2) already refuses a non-empty directory, so this is redundant
      // today — it is here so that swapping in `fs.rmSync({recursive:true})`
      // later cannot silently turn an unwind into a delete.
      if (fs.readdirSync(dir).length > 0) continue;
      fs.rmdirSync(dir);
    } catch { /* already gone, or not ours to remove — leave it */ }
  }
}

// Build the whole staging directory one verified level at a time, then re-check
// the finished path against the path it was constructed to be. The final
// realpath comparison is not the containment check — the descent is — it is the
// net that catches a component swapped WHILE we were descending.
function buildStagingDir(realRoot, components) {
  const created = [];
  let current = realRoot;
  try {
    components.forEach((component, index) => {
      current = ensureRealChildDir(current, component, index + 1, created);
    });

    const expected = path.join(realRoot, ...components);
    let resolved;
    try {
      resolved = fs.realpathSync(current);
    } catch (err) {
      throw wrapFsError("jail_realpath_failed", "cannot resolve the staging directory", err);
    }
    if (resolved !== expected) {
      throw refuse("jail_escape_realpath_mismatch", "the staging directory moved out of the jail while it was being created");
    }
    return resolved;
  } catch (err) {
    unwindCreatedDirs(created);
    throw err;
  }
}

// Never leave a partial transcript behind after a refusal — and never unlink
// anything that is not still the exact inode we created. `unlink` is
// path-based, so identity is checked before it runs; if the path no longer
// leads to our file, the leftover is left alone rather than deleting a
// stranger's.
function removeStagingFile(staging, dev, ino) {
  try {
    const leftover = fs.lstatSync(staging);
    const isOurs = dev === null || (leftover.dev === dev && leftover.ino === ino);
    if (leftover.isFile() && isOurs) fs.unlinkSync(staging);
  } catch { /* already gone, or not ours to remove */ }
}

// Write `contents` to `<stagingDir>/<leafName>` in a way that cannot deliver a
// single byte anywhere else.
function writeStagedFile(stagingDir, leafName, contents) {
  const target = path.join(stagingDir, leafName);

  // Refuse loudly on anything pre-planted at the leaf. The rename below would
  // already make these harmless (it replaces the directory entry instead of
  // writing through it), but a hostile leaf means the sandbox is under active
  // attack and that must reach the operator, not be quietly overwritten.
  let existing = null;
  try {
    existing = fs.lstatSync(target);
  } catch (err) {
    if (err?.code !== "ENOENT") throw wrapFsError("jail_lstat_failed", "cannot stat the session file path", err);
  }
  if (existing?.isSymbolicLink()) {
    throw refuse("jail_escape_symlinked_leaf", "refusing to follow a symlink at the session file path");
  }
  if (existing && !existing.isFile()) {
    throw refuse("jail_escape_leaf_not_a_regular_file", "the session file path is not a regular file");
  }
  if (existing && existing.nlink > 1) {
    // A hard link has no link-ness at the path level and O_NOFOLLOW cannot see
    // it: opening this name would write straight into a file outside the jail.
    throw refuse("jail_escape_hardlinked_leaf", "the session file path is hard-linked to another file");
  }

  // A name the attacker cannot have pre-placed, created with O_EXCL so we know
  // WE created it and O_NOFOLLOW so it cannot be a symlink. No O_TRUNC exists
  // anywhere in this module: nothing is destroyed before it is validated.
  const staging = path.join(stagingDir, `.relayd-import-${crypto.randomBytes(16).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(
      staging,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    throw wrapFsError("jail_staging_open_failed", "cannot create the staging file", err);
  }

  let ok = false;
  let stagedDev = null;
  let stagedIno = null;
  try {
    const opened = guarded("jail_verify_failed", "cannot verify the staging file after creation", () => fs.fstatSync(fd));
    stagedDev = opened.dev;
    stagedIno = opened.ino;
    if (!opened.isFile() || opened.nlink !== 1) {
      throw refuse("jail_escape_staging_race", "the staging file was not the fresh regular file we created");
    }
    // The staging file is one we just created, so resolving IT (rather than a
    // directory we are about to write into) tells us where the bytes will
    // actually land. Compare by inode as well as by path: a path comparison
    // alone can be satisfied by a swapped-back symlink.
    const landed = guarded("jail_verify_failed", "cannot verify the staging file's location", () => fs.lstatSync(staging));
    if (landed.dev !== opened.dev || landed.ino !== opened.ino) {
      throw refuse("jail_escape_staging_race", "the staging file was replaced between creation and validation");
    }
    const resolvedStaging = guarded("jail_verify_failed", "cannot resolve the staging file's real path", () => fs.realpathSync(staging));
    if (resolvedStaging !== staging) {
      throw refuse("jail_escape_staging_race", "the staging file is no longer where it was created");
    }

    guarded("jail_staging_io_failed", "cannot set the staging file's mode", () => fs.fchmodSync(fd, 0o600));

    // Last look at the fd's own link count, immediately before the write and
    // with NO fs call in between this check and it. The two checks above are
    // still path-based (they re-resolve `staging` from `/`), so a two-window
    // race — swap the staging directory for a symlink out of the jail before
    // the open above, hard-link the resulting (still empty) file back into
    // the restored real directory, then restore the directory — defeats them
    // both: by the time they run, `staging` genuinely does resolve in-jail,
    // to the same inode as `fd`, because it now IS one of that inode's two
    // links. What that race cannot defeat is this: fstat(fd) reads the
    // inode's live link count with no dependency on any path, and the extra
    // link created by that attack exists well before this instant, so it is
    // already visible here — BEFORE a single byte of session content is
    // written. This is the check that keeps a lost race here to "an empty
    // file the module created may be left outside the jail" rather than "the
    // transcript itself may be left outside the jail" (see the module header
    // RESIDUAL section for the guarantee this leaves in place).
    const preWrite = guarded("jail_verify_failed", "cannot verify the staging file immediately before the write", () => fs.fstatSync(fd));
    if (preWrite.nlink !== 1) {
      throw refuse("jail_escape_staging_race", "the staging file was linked or replaced before the write could start");
    }

    guarded("jail_staging_io_failed", "cannot write the staging file", () => fs.writeFileSync(fd, contents));

    const written = guarded("jail_verify_failed", "cannot verify the staging file after the write", () => fs.fstatSync(fd));
    if (written.nlink !== 1 || written.dev !== opened.dev || written.ino !== opened.ino) {
      // Someone hard-linked or replaced our staging file while we wrote it.
      throw refuse("jail_escape_staging_race", "the staging file was linked or replaced during the write");
    }
    ok = true;
  } finally {
    // Best-effort: release our own fd promptly. Must never replace whichever
    // error (typed refusal or otherwise) is already propagating out of this
    // block, and close(2) on an fd we just successfully used is not a
    // realistic failure mode worth its own typed code.
    try { fs.closeSync(fd); } catch { /* fd is ours; nothing more to do */ }
    if (!ok) removeStagingFile(staging, stagedDev, stagedIno);
  }

  // `rename` replaces the destination directory ENTRY. It does not follow a
  // symlink there and it does not write through a hard link there, so even a
  // leaf planted between the check above and this call receives nothing; the
  // worst an attacker gets is their own planted entry being unlinked.
  try {
    fs.renameSync(staging, target);
  } catch (err) {
    removeStagingFile(staging, stagedDev, stagedIno);
    throw wrapFsError("jail_publish_failed", "cannot move the staged session file into place", err);
  }

  // Last look: the entry now at the target must be exactly the inode we wrote,
  // still a regular file, still with a single link. This is what makes a lost
  // race at the very last instant loud instead of silent.
  //
  // Not defended, because it is not defensible and not worth defending: the
  // staged transcript lives in the agent's own HOME, so the agent can copy or
  // hard-link it wherever it likes AFTER this function returns. That gives an
  // attacker nothing — `link()` fails if the destination exists, so it cannot
  // clobber a victim, and the transcript is the attacker's own data. The
  // property is about writes landing at paths of the ATTACKER's choosing
  // through OUR privileges, and no such write survives this check.
  let published;
  try {
    published = fs.lstatSync(target);
  } catch (err) {
    throw wrapFsError("jail_publish_unverifiable", "cannot verify the published session file", err);
  }
  if (!published.isFile() || published.nlink !== 1 || published.dev !== stagedDev || published.ino !== stagedIno) {
    throw refuse("jail_escape_publish_race", "the published session file is not the file we staged");
  }
}

// The single entry point for every write this module performs.
function stageSessionFile({ jailRoot, components, leafName, contents }) {
  const realRoot = resolveJailRoot(jailRoot);
  const stagingDir = buildStagingDir(realRoot, components);
  // See the note on `assertContained` above: for the current, fixed shape of
  // `leafName` this call is unreachable by construction and cannot refuse
  // anything. The real containment guarantee is the per-component descent in
  // buildStagingDir/ensureRealChildDir above.
  assertContained(stagingDir, path.join(stagingDir, leafName));
  writeStagedFile(stagingDir, leafName, contents);
  return path.join(stagingDir, leafName);
}

function summaryPrompt(manifest) {
  const title = manifest.title || "an untitled session";
  const repo = manifest.repo || "an unknown repo";
  const branch = manifest.branch || "an unknown branch";
  const lines = [
    `Continue this handed-off session: ${title}`,
    "",
    `It was running on ${manifest.machine || "another machine"} in ${repo}, on branch ${branch}.`,
  ];
  if (manifest.wip?.summary) lines.push(`Uncommitted work carried over: ${manifest.wip.summary}.`);
  if (manifest.excerpt) lines.push("", "Where it left off:", manifest.excerpt);
  lines.push("", "Pick up from there. The working tree already contains that work.");
  return lines.join("\n");
}

function importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath }) {
  // An unrecognized harness deliberately degrades to the claude branch (it's
  // the most conservative resume path — a primed prompt with no session
  // file). requestedHarness keeps that degradation observable instead of
  // silent, so callers/logs can tell what was actually asked for.
  const requestedHarness = manifest.harness;
  const provider = ["codex", "cursor", "kimi"].includes(manifest.harness) ? manifest.harness : "claude";

  if (sessionBytes && manifest.sessionFormat === "claude-jsonl" && manifest.sessionId) {
    const sessionId = assertSafeSessionId(manifest.sessionId);
    const rewritten = rewriteSessionCwd(sessionBytes.toString("utf8"), {
      fromCwd: manifest.cwd,
      toCwd: worktreePath,
    });
    stageSessionFile({
      jailRoot: runHome,
      components: [".claude", "projects", claudeProjectSlug(worktreePath)],
      leafName: `${sessionId}.jsonl`,
      contents: rewritten,
    });
    return { provider: "claude", requestedHarness, resumeSessionId: sessionId, primedPrompt: null };
  }

  if (sessionBytes && manifest.sessionFormat === "codex-rollout" && manifest.sessionId) {
    const sessionId = assertSafeSessionId(manifest.sessionId);
    // A Codex rollout is resumed BY ID, so this rewrite is not what makes the
    // resume work — but `threads.readSessionMeta` reads `payload.cwd` out of
    // this very file and `jobs.createJob` refuses the resume 400 unless that
    // path resolves to the workspace being resumed into. Leaving the laptop
    // path here is therefore both a hard functional break and the same
    // username leak the Claude branch has always rewritten away.
    const rewritten = rewriteSessionCwd(sessionBytes.toString("utf8"), {
      fromCwd: manifest.cwd,
      toCwd: worktreePath,
    });
    stageSessionFile({
      jailRoot: codexHome,
      components: ["sessions"],
      leafName: codexRolloutLeafName(sessionId, manifest.createdAt),
      contents: rewritten,
    });
    return { provider: "codex", requestedHarness, resumeSessionId: sessionId, primedPrompt: null };
  }

  return { provider, requestedHarness, resumeSessionId: null, primedPrompt: summaryPrompt(manifest) };
}

export {
  HANDOFF_MANIFEST_VERSION,
  SessionImportSecurityError,
  assertContained,
  claudeProjectSlug,
  codexRolloutLeafName,
  repairLegacyCodexRollout,
  rewriteSessionCwd,
  summaryPrompt,
  importSession,
};
