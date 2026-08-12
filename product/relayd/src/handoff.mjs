// relayd handoff.mjs — the sandbox end of `relay handoff`.
//
// Pickup is a long-poll against the control plane, which learns only names.
// Everything with content comes over git: the branch carries the work, and two
// blobs sealed to this node's X25519 key carry the manifest and the session
// transcript. They are decrypted here and nowhere else.
//
// ---------------------------------------------------------------------------
// THREAT MODEL — read this before changing anything below.
//
// Every value in a handoff descriptor arrives over the network (the cloud's
// long-poll response, ultimately relayed from whatever pushed the handoff) and
// is attacker-controlled: the id becomes a filesystem path segment, the repo
// becomes a clone URL, the branch becomes a `git clone --branch` argument, and
// the manifest — sealed to a PUBLISHED encryption key — is whatever the sender
// chose to put in it. The coding agent that shares this sandbox runs as the
// same uid with its cwd inside the browse root, so it can create, delete and
// swap entries there while we work.
//
// TWO PROPERTIES govern this module. Neither is a list of patched findings.
// PROPERTY 1 is stated exactly, not rounded up to something tidier — a
// second, independent review found the tidier version false and the true one
// still holds; read RESIDUAL below before trusting any summary of what this
// module guarantees, including this one:
//
//   1. No sequence of symlinks, renames or unlinks can make this module
//      RESOLVE A NAME THE ATTACKER CONTROLS and write through it. This is
//      NOT the same as "nothing this module creates ever exists outside the
//      jail at any instant" — that stronger claim is false in the presence
//      of the same-uid attacker this module's own threat model assumes; see
//      RESIDUAL.
//
//   2. Every handoff reaches a terminal, visible state. No input may leave one
//      wedged in `importing`, and no failure may be silent.
//
// PROPERTY 1 is structural, not checked. The previous round validated
// containment with `fs.realpathSync` AFTER `git clone` returned, which cannot
// hold the property: by the time the check runs the write has already
// happened. A five-line same-uid racer that symlinked the checkout path
// between the pre-clone `rmSync` and git's own `mkdir` put an entire
// repository outside the jail on the reviewer's first attempt, and the module
// left it there.
//
// The rewrite that holds the property (the same conclusion
// `sessionimport.mjs` reached after three failed rounds — this reuses its
// lesson rather than inventing a second answer) is: STOP NAMING THE PATH.
// Every escape here is a path being re-resolved from `/` by the next syscall
// and getting a different answer. Node has no *at() syscalls, but it does have
// the process working directory, which the kernel holds as an INODE:
//
//   a. The jail root is resolved ONCE per import (`resolveJailRoot`) and must
//      still equal the realpath config froze at boot; every containment check
//      in workspaces.mjs compares against that frozen string, so if the root
//      itself moved, no downstream check means anything and we refuse.
//   b. `withPinnedCwd` chdirs into it and proves it with getcwd(2), which
//      reports the pinned INODE's real path — so a symlinked or swapped
//      component is caught before anything is written.
//   c. The staging directory is created RELATIVE to that pinned root (128 bits
//      of entropy in the name, so there is nothing to pre-plant at), and the
//      process pins that in turn.
//   d. git is spawned with no `cwd` option, so it INHERITS the pinned inode
//      across fork, and its destination argument is `"."`. There is no
//      component left above the destination for anyone to swap: the clone
//      cannot land anywhere else, whatever happens to the names.
//   e. Publishing renames one pinned component onto another inside the pinned
//      root, after proving the source is still the exact inode git cloned into.
//      Renaming a directory onto a symlink fails ENOTDIR rather than writing
//      through it, so a symlink planted at the stable name receives nothing.
//   f. Every failure path removes what it created — and ONLY what it created:
//      cleanup re-checks inode identity, because a cleanup that deletes what it
//      did not create is an arbitrary-delete primitive aimed wherever the
//      attacker points it.
//
// The cost is that `process.chdir` is process-global. Each pinned block is
// therefore straight-line synchronous code with no `await` in it — no other
// JavaScript can run, let alone observe the changed cwd — and the cwd is
// restored in a `finally` before the clone has done anything at all (`spawn`
// creates the child synchronously; only its completion is asynchronous).
//
// RESIDUAL, stated rather than hidden, and corrected once already — an
// earlier version of this paragraph claimed the relocation below was "not a
// path of their choosing"; a reviewer moved a complete in-progress clone
// (2,446 filesystem entries) to a destination they picked and proved that
// claim wrong. What is actually true, no more and no less:
//
//   - A same-uid attacker CAN `rename` a directory we created, at any moment,
//     to A DESTINATION OF THEIR CHOOSING, and the bytes follow the inode
//     there. That destination is real, not hypothetical, and is exactly as
//     attacker-chosen as any other path they control.
//   - What they gain from it is nothing: no privilege of this module is
//     borrowed to do it (relayd and the harness sharing this sandbox run at
//     the same uid with no drop, so the attacker could already read and write
//     that destination directly), and the relocated tree can NEVER be
//     published under a handoff's name — the identity check at (e) compares
//     the entry about to be published against the exact inode git cloned
//     into, and a renamed-away directory fails that check every time.
//
// So: no sequence of symlinks, renames or unlinks can make this module
// RESOLVE a name the attacker controls and write through it — that is
// PROPERTY 1 as stated above, and it holds. "Nothing this module creates
// exists outside the jail at any instant" is a different, stronger claim,
// and it does NOT hold: a lost race can leave a complete tree this module
// created sitting outside the jail, at a path the attacker chose, forever —
// just never listed, never resumed, and never reachable through this
// module's own jailed name for it.
//
// PROPERTY 2 is structural too. `importHandoff` is a settle function: the
// whole pickup runs inside `runImport`, which either returns a ready record or
// throws, and EVERY throw — including one from `importSession`, from the
// store, or from a malformed manifest — lands in one catch that announces a
// failure exactly once. Nothing after the clone sits outside that.
//
// WHAT NEVER LEAVES THIS MODULE: `record.error` is drawn from a CLOSED
// vocabulary (`PUBLIC_REASONS`). Raw child stderr, argv, absolute host paths
// and `.cause` chains are attacker-influenced and are served to the phone by
// `GET /v1/handoffs`, so they never reach a record — they go to the local
// audit log, clipped and credential-redacted. The GitHub credential lives in
// `<runHome>/.git-credentials` (helper = store) and is never named in argv.
//
// BOTH writers of `record.error` go through the same membership gate, and the
// second one had to be fixed to make that true: the import path via
// `publicReason(error)`, the push-back path via `publicCode(reason)` inside
// `announcePushOutcome`. A reviewer found this claim asserted while
// `announcePushOutcome` persisted its caller's string verbatim — seven values
// that were not in the set. It was safe only because all seven happened to be
// static literals, which is an accident, not a guarantee. If you add a writer
// of `record.error`, route it through `publicCode` or this paragraph becomes
// false again.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

import { workspaceBrowseRoot, runHome as configuredRunHome, codexHome, gitBin } from "./config.mjs";
import { identityPaths, readEncPrivateKeyPem } from "./identity.mjs";
import { openSealed } from "./seal.mjs";
import { importSession } from "./sessionimport.mjs";
import { browseWorkspaceForPath, resolvedPathWithinRoot } from "./workspaces.mjs";
import { store } from "./store.mjs";
import { emitEvent } from "./events.mjs";
import { appendAudit } from "./audit.mjs";
import { enqueueJob, jobs } from "./jobs.mjs";
import { nowIso } from "./util.mjs";

// execFile's own `timeout` option sends `killSignal` (SIGTERM by default)
// exactly ONCE when it elapses. Real git does not trap SIGTERM, so this is
// untested against real git — but any child that DOES ignore it (a wedged
// helper, a broken credential prompt that swallows signals) leaves the
// callback unfired and the promise pending FOREVER: runImport, and therefore
// the whole pickup loop behind it, wedges — the one remaining unbounded wait
// in this module. Escalate: if the child is still alive a grace period after
// its own timeout should have ended it, send SIGKILL unconditionally. This
// bypasses the injectable execFileImpl on purpose — it is the PRODUCTION
// default, not something a test should be able to weaken by supplying its own
// execFileImpl without also opting into no escalation.
const GIT_KILL_GRACE_MS = 3000;

function execFileEscalating(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    let killTimer = null;
    const child = execFile(bin, args, options, (error, stdout, stderr) => {
      if (killTimer) clearTimeout(killTimer);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
    if (Number.isFinite(options.timeout)) {
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }, options.timeout + GIT_KILL_GRACE_MS);
      killTimer.unref?.();
    }
  });
}

const MAX_SEALED_BLOB_BYTES = 20 * 1024 * 1024;
// A manifest is a few hundred bytes of names. 64 KB is three orders of
// magnitude of headroom and still bounds JSON.parse on attacker input.
const MAX_MANIFEST_BYTES = 64 * 1024;
// Bounds on individual manifest fields. Anything longer is clipped, not
// rejected: a 2 MB title used to become a 10.5 MB record that `GET
// /v1/handoffs` then served in full, once per handoff, in one body.
const MAX_TITLE = 200;
const MAX_NAME = 255;
const MAX_PATHISH = 4096;
const MAX_EXCERPT = 2000;
const MAX_SUMMARY = 300;
// No git invocation may hang the pickup loop: an unresponsive origin would
// otherwise wedge a handoff in `importing` forever (property 2) and stop every
// later handoff behind it.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_MAX_BUFFER = 1024 * 1024;
// Unconditional floor between polls, INCLUDING the success path. Without it a
// cloud that answers immediately produced 78,199 polls/second, and a poll that
// resolved without an event-loop turn made the loop pure microtasks and
// starved the daemon dead at 99.3% CPU.
const POLL_FLOOR_MS = 1000;
const MIN_POLL_WAIT_SEC = 1;
const MAX_POLL_BATCH = 20;
const TERMINAL_JOB_STATUSES = new Set(["succeeded", "failed", "cancelled", "timeout"]);

// Deliberately a STRICT SUBSET of store.mjs's own record-id charset
// (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/): no dots at all, so an id this module
// accepts can never contain the "/" or ".." that would let it navigate once
// joined, and is always also acceptable to store.saveHandoff. The cloud emits
// /^[a-f0-9]{16,64}$/ (server.js), so 64 is the real ceiling, not a guess.
const SAFE_HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// GitHub owner/repo shape only. Rejects anything that could turn the
// `https://github.com/<repo>.git` clone URL into a different host, a local
// path, or an unexpected transport. No shell is involved (execFile takes an
// argv array), so classic quoting injection is not the risk; a malformed repo
// string changing the URL's *meaning* is — and keeping the host pinned to
// github.com is also what keeps git's host-scoped credential from being
// offered to anyone else.
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

// ---------------------------------------------------------------------------
// Errors: one class, a machine-readable code, and a closed public vocabulary.

class HandoffError extends Error {
  constructor(code, detail, options) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.name = "HandoffError";
    this.code = code;
  }
}

function refuse(code, detail, cause) {
  return new HandoffError(code, detail, cause ? { cause } : undefined);
}

// The ONLY strings that may ever land in `record.error`, which additions.mjs
// serves verbatim to the phone. A reason not in this set becomes
// "internal_error", so no message, path, argv, stderr or `.cause` an attacker
// can influence has a route to a client — the guarantee is structural, not a
// sanitiser that has to anticipate every format. Deliberately coarse in one
// place: a failed clone says only `clone_failed`, never "Repository not found"
// vs an auth error, because that difference is a private-repo existence oracle
// against the user's own credential, readable by anyone holding the phone cert.
const PUBLIC_REASONS = new Set([
  "invalid_handoff_id",
  "invalid_repo",
  "invalid_branch",
  "jail_root_unusable",
  "checkout_create_failed",
  "checkout_publish_failed",
  "checkout_escaped_jail",
  "clone_failed",
  "no_encryption_key",
  "manifest_missing",
  "manifest_unreadable",
  "manifest_too_large",
  "manifest_invalid",
  "manifest_id_mismatch",
  "unsupported_manifest_version",
  "blob_outside_checkout",
  "blob_too_large",
  "blob_unreadable",
  "seal_bad_magic",
  "seal_truncated",
  "seal_decrypt_failed",
  "session_staging_failed",
  "workspace_registration_failed",
  "store_write_failed",
  "internal_error",
  // The PUSH-BACK half of the vocabulary. These were persisted into
  // `record.error` for a release without being in this set and without going
  // through publicCode — the header above claimed the guarantee was
  // structural while the only thing holding it was that all seven happened to
  // be static literals. No live leak, but the gate that would catch the next
  // edit adding a detail to a push reason did not exist. It does now: every
  // one of these is a member, and announcePushOutcome routes through
  // publicCode, so this set really is the whole vocabulary.
  "push_failed",
  "push_blocked_secret",
  "checkout_missing",
  "record_missing",
  // `job_<status>` for the jobs engine's own terminal statuses. Any other
  // status — one added later, or a non-string — becomes internal_error rather
  // than coining a vocabulary word at runtime.
  "job_failed",
  "job_cancelled",
  "job_timeout",
  "job_unknown",
]);

// The membership test itself, taking the code directly. `publicReason` is the
// error-shaped door onto it; the push-back path has reasons that never were an
// Error, and both must pass through the SAME gate or the set is not closed.
function publicCode(code) {
  return typeof code === "string" && PUBLIC_REASONS.has(code) ? code : "internal_error";
}

function publicReason(error) {
  return publicCode(error?.code);
}

// Credential shapes that must never reach even the LOCAL audit log. The
// reviewer proved the error channel end to end with a git stub that echoed
// `$HOME/.git-credentials` to stderr; real git happens to be clean today, and
// this exists so that stays true when it isn't.
const SECRET_PATTERNS = [
  /(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, // user:password@host
  /gh[pousr]_[A-Za-z0-9]{16,}/g,
  /github_pat_[A-Za-z0-9_]{16,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // long opaque blobs: tokens, b64 secrets
];

function redactSecrets(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) => (prefix ? `${prefix}[redacted]@` : "[redacted]"));
  }
  return out;
}

function clip(text, max) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}...(+${value.length - max} more)` : value;
}

// Detail for the LOCAL audit log only — never for a record, an event or an
// HTTP response. Carries the cause chain and any child stderr, redacted and
// clipped.
function operatorDetail(error) {
  const parts = [];
  for (let current = error; current && parts.length < 4; current = current.cause) {
    parts.push(current.message || String(current));
    if (typeof current.stderr === "string" && current.stderr.trim()) parts.push(current.stderr.trim());
  }
  return clip(redactSecrets(parts.join(" <- ")), 600);
}

// Attacker-controlled values echoed for an operator are clipped first: an id
// can be 4 KB long.
function redactUntrusted(value) {
  const text = typeof value === "string" ? value : Object.prototype.toString.call(value);
  return clip(redactSecrets(text), 64);
}

// ---------------------------------------------------------------------------
// Descriptor validation. Predicate + assert share one definition so deleting
// either half is a visible edit, not a silent widening.

const isSafeHandoffId = (value) => typeof value === "string" && SAFE_HANDOFF_ID.test(value);
const isSafeRepo = (value) =>
  typeof value === "string" && SAFE_REPO.test(value) && !value.includes("..");

// Loose but real: rejects empty/oversized/whitespace/control-character branch
// names, a leading "-" (which would otherwise sit as the first byte of the
// `--branch` argument's value) and "..". Not a full `git check-ref-format` —
// this only needs to be safe as an execFile argv element and as a value later
// reused as a `git push origin <branch>` argument.
const isSafeBranch = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_NAME &&
  !/[\0-\x1f\s]/.test(value) &&
  !value.includes("..") &&
  !value.startsWith("-");

function assertSafeHandoffId(id) {
  if (!isSafeHandoffId(id)) throw refuse("invalid_handoff_id", redactUntrusted(id));
  return id;
}

function assertSafeRepo(repo) {
  if (!isSafeRepo(repo)) throw refuse("invalid_repo", redactUntrusted(repo));
  return repo;
}

function assertSafeBranch(branch) {
  if (!isSafeBranch(branch)) throw refuse("invalid_branch", redactUntrusted(branch));
  return branch;
}

// <workspaceBrowseRoot>/handoff-<id>-<sha256(id) truncated>.
//
// The hash is what makes this INJECTIVE, and it is not decoration:
//
//  - The previous round used `id.slice(0, 12)`, so two distinct handoffs
//    sharing a 12-character prefix shared one checkout: the second one's
//    `rmSync` destroyed the first one's uncommitted work, both got the same
//    workspace id, and a `continue` on A ran in B's tree and pushed to A's
//    branch. Never truncate an id into a path.
//  - The full id alone is still not injective: macOS APFS is case-insensitive
//    by default, so `handoff-ABC` and `handoff-abc` are ONE directory. 128 bits
//    of sha256 over the exact id separate them (a birthday search over
//    case-variants would need 2^64 work).
//  - The whole name is kept at or under 76 characters so that workspaces.mjs's
//    `dynamicWorkspaceId` (`dir-` + name, sliced to 80) never truncates
//    either — otherwise two long ids would land on one workspace id and
//    `findDynamicWorkspaceById` could route a job into the wrong checkout
//    after a restart. The id is capped at 64 by SAFE_HANDOFF_ID and 8 + 64 + 1
//    + 32 = 105 exceeds that, so the READABLE part is clipped to 35 — purely
//    cosmetic, since uniqueness comes from the hash of the FULL id.
function checkoutDirName(handoffId) {
  const id = assertSafeHandoffId(handoffId);
  const digest = crypto.createHash("sha256").update(id, "utf8").digest("hex").slice(0, 32);
  return `handoff-${id.slice(0, 35)}-${digest}`;
}

function checkoutPathFor(handoffId) {
  return path.join(workspaceBrowseRoot, checkoutDirName(handoffId));
}

// ---------------------------------------------------------------------------
// The jail.

// Resolve and pin the browse root. `workspaceBrowseRoot` is realpath-frozen at
// config load and every containment check downstream compares against that
// frozen string; if the real root has moved since (renamed aside and replaced
// with a symlink, say) then no downstream check means anything, so this fails
// closed rather than proceeding with a stale notion of "inside".
function resolveJailRoot() {
  try {
    fs.mkdirSync(workspaceBrowseRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw refuse("jail_root_unusable", `cannot create the browse root (${error?.code})`, error);
    }
  }
  let stat;
  try {
    stat = fs.lstatSync(workspaceBrowseRoot);
  } catch (error) {
    throw refuse("jail_root_unusable", `cannot stat the browse root (${error?.code})`, error);
  }
  if (stat.isSymbolicLink()) throw refuse("jail_root_unusable", "the browse root is a symlink");
  if (!stat.isDirectory()) throw refuse("jail_root_unusable", "the browse root is not a directory");
  let real;
  try {
    real = fs.realpathSync(workspaceBrowseRoot);
  } catch (error) {
    throw refuse("jail_root_unusable", `cannot resolve the browse root (${error?.code})`, error);
  }
  if (real !== workspaceBrowseRoot) {
    throw refuse("jail_root_unusable", "the browse root moved after startup");
  }
  return real;
}

// ── Inode pinning ──────────────────────────────────────────────────────────
//
// EVERY escape this module has to prevent is the same bug: a path is checked,
// and then a syscall RE-RESOLVES that path from `/` and gets a different
// answer, because a same-uid attacker renamed or symlinked a component in
// between. Checking harder does not fix it. The only fix is to stop naming the
// paths at all.
//
// Node exposes no `openat`/`mkdirat`/`renameat`, so the one inode-relative
// mechanism available is the PROCESS WORKING DIRECTORY: after `chdir`, the
// kernel holds a reference to that inode, and every relative path resolves
// from it — no lookup of any component above, ever again. `fork` copies that
// reference, so a child process started here inherits the same pinned
// directory and its `.` means the same inode even if every name above it is
// swapped mid-clone.
//
// So the whole of the create-clone-publish sequence runs relative to a pinned
// cwd. `process.chdir` is process-global, which is why each block below is
// STRAIGHT-LINE SYNCHRONOUS CODE with no `await` in it: no other JavaScript
// can run, let alone observe the changed cwd, and it is restored in a `finally`
// before the block returns. (`spawn` creates the child synchronously; only its
// completion is asynchronous, and by then the cwd is already restored.)
//
// LANDMINE FOR THE NEXT EDIT (m-10): libuv resolves a relative `fs` path in
// its threadpool thread at SYSCALL time, not at call time — so an ASYNC fs
// call issued anywhere in this process, even one that looks unrelated,
// before a pinned block's `chdir` can still resolve against the MOVED cwd if
// its syscall hasn't run yet by the time the pin lands. This does not bite
// today because every pinned block here is genuinely await-free and
// `relayd/src` has no other relative-path `fs` call site — but the moment
// either of those stops being true, a bystander async fs call becomes
// capturable. Do not add an `await` inside a pinned block, and do not add a
// relative-path fs call (including a relative RELAYD_GIT_BIN) anywhere else
// in this daemon without re-checking this.
function withPinnedCwd(dir, expected, fn) {
  if (typeof process.chdir !== "function") {
    // A worker thread has no chdir, so nothing here can hold its guarantee.
    // Refusing is the honest outcome; relayd's loop runs on the main thread.
    throw refuse("checkout_create_failed", "inode pinning is unavailable in this thread");
  }
  const previous = process.cwd();
  try {
    process.chdir(dir);
    // getcwd(2) walks up from the pinned inode, so this is the inode's REAL
    // path, not the string we asked for: if `dir` was a symlink, or an
    // ancestor was swapped, or the browse root itself was renamed aside and
    // replaced, the two differ and nothing has been written yet.
    //
    // (m-11) This proof depends on being the FIRST process.cwd() call after
    // the chdir above, and on nothing else. Node CACHES the cwd string on
    // every call after the one right after a chdir, so a second call here
    // would silently read the cache instead of calling getcwd(2) again — the
    // check would still pass, but it would no longer be proving anything.
    // Do not insert another process.cwd() (or anything that might call it)
    // between the chdir above and this line.
    if (process.cwd() !== expected) {
      throw refuse("checkout_escaped_jail", "the working directory is not the directory we asked for");
    }
    return fn();
  } finally {
    try {
      process.chdir(previous);
    } catch (error) {
      // Losing the original cwd would silently change how every later relative
      // path in this process resolves. Land somewhere harmless and say so.
      safeAudit("handoff_cwd_restore_failed", { detail: operatorDetail(error) });
      try {
        process.chdir("/");
      } catch {
        /* nothing further to try */
      }
    }
  }
}

function sameInode(left, right) {
  return Boolean(left) && Boolean(right) && left.dev === right.dev && left.ino === right.ino;
}

// Is the entry at `name` (a single component of the pinned cwd) still the exact
// inode we cloned into? Identity, not existence: an attacker who moved our
// directory aside and put their own — or a symlink — at the same name leaves a
// perfectly plausible entry there.
function stagingIsOurs(handle, name) {
  let entry;
  try {
    entry = fs.lstatSync(name);
  } catch {
    return false;
  }
  return entry.isDirectory() && !entry.isSymbolicLink() && sameInode(entry, handle);
}

// Move the verified staging tree onto the stable per-handoff name. Both names
// are single components resolved from the PINNED browse root, so neither the
// source nor the destination can be re-pointed by anything above them.
//
// `rename` replaces the destination ENTRY: it does not follow a symlink there,
// and renaming a directory onto a symlink fails ENOTDIR rather than writing
// through it. So a symlink planted in the window between the removal and the
// rename receives nothing and we fail closed.
function publishCheckout(realRoot, handle, finalName) {
  const finalPath = path.join(realRoot, finalName);
  withPinnedCwd(realRoot, realRoot, () => {
    // The one check that decides whether this tree is publishable at all: the
    // entry we are about to move must be the exact inode git cloned into. A
    // lost race — our directory renamed aside and the attacker's own left in
    // its place — stops here, before their tree is moved into the jail under a
    // handoff's name and before a single record says "ready".
    if (!stagingIsOurs(handle, handle.name)) {
      throw refuse("checkout_escaped_jail", "the checkout was replaced while it was being written");
    }
    removePinnedEntry(finalName);
    try {
      fs.renameSync(handle.name, finalName);
    } catch (error) {
      throw refuse("checkout_publish_failed", `cannot move the checkout into place (${error?.code})`, error);
    }
    let published;
    try {
      published = fs.lstatSync(finalName);
    } catch (error) {
      throw refuse("checkout_escaped_jail", `cannot verify the published checkout (${error?.code})`, error);
    }
    // Defence in depth, deliberately kept although the check above already
    // covers every case a test can reach: it is the only thing that would
    // notice a swap landing between that check and this rename.
    if (!published.isDirectory() || !sameInode(published, handle)) {
      throw refuse("checkout_escaped_jail", "the published checkout is not the tree we cloned");
    }
  });
  return finalPath;
}

// Remove one entry of the pinned cwd. Only ever called with a single path
// component from inside `withPinnedCwd`, so there is no component above it to
// resolve and no way for it to name anything outside the jail. A symlink is
// unlinked, never followed.
function removePinnedEntry(name) {
  let entry;
  try {
    entry = fs.lstatSync(name);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw refuse("checkout_publish_failed", `cannot stat the checkout path (${error?.code})`, error);
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    // lstat-then-unlink is two syscalls with nothing this module controls in
    // between. If the entry is already gone by the time unlink runs, that is
    // not a failure — what this call wanted gone is already gone — but
    // without this catch the raw ENOENT propagated uncaught and turned a
    // clean import into a public "internal_error".
    try {
      fs.unlinkSync(name);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    return true;
  }
  fs.rmSync(name, { recursive: true, force: true });
  return true;
}

// The ONE delete in this module. Refuses to remove anything that is not really
// inside the jail, and unlinks a symlink AT the target rather than following
// it (fs.rmSync already unlinks rather than descends, this is explicit so the
// intent survives an edit).
function removeInsideJail(target) {
  let entry = null;
  try {
    entry = fs.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw refuse("checkout_publish_failed", `cannot stat the checkout path (${error?.code})`, error);
  }
  if (entry.isSymbolicLink()) {
    fs.unlinkSync(target);
    return true;
  }
  let real;
  try {
    real = fs.realpathSync(target);
  } catch (error) {
    throw refuse("checkout_publish_failed", `cannot resolve the checkout path (${error?.code})`, error);
  }
  if (real === workspaceBrowseRoot || !resolvedPathWithinRoot(real)) {
    throw refuse("checkout_escaped_jail", "refusing to remove a path outside the jail");
  }
  fs.rmSync(real, { recursive: true, force: true });
  return true;
}

// Remove the staging directory, but ONLY while it is still the inode we
// created. If a lost race left someone else's directory (or a symlink) at that
// name, it is not ours and deleting it would turn a containment failure into
// an arbitrary-delete primitive pointed at whatever they chose.
function removeStagingIfOurs(realRoot, handle) {
  try {
    withPinnedCwd(realRoot, realRoot, () => {
      if (!stagingIsOurs(handle, handle.name)) {
        safeAudit("handoff_staging_not_ours", { detail: "the staging directory was replaced; leaving it alone" });
        return;
      }
      fs.rmSync(handle.name, { recursive: true, force: true });
    });
  } catch (error) {
    safeAudit("handoff_cleanup_failed", { detail: operatorDetail(error) });
  }
}

// Best-effort cleanup used on failure paths: a cleanup that throws must not
// replace the failure that caused it.
function removeQuietly(target) {
  if (!target) return;
  try {
    removeInsideJail(target);
  } catch (error) {
    safeAudit("handoff_cleanup_failed", { detail: operatorDetail(error) });
  }
}

// ---------------------------------------------------------------------------
// Sealed blobs.

// Reads one sealed blob out of the (already containment-verified) checkout.
// The directory is ours, but its CONTENTS come from a remote-supplied git
// branch: a malicious commit can plant a symlink at
// `.relay/handoff/<id>/<name>` — or at any component above it — aimed outside
// the checkout, and statSync/readFileSync would follow it.
function readSealedBlob(realCheckout, handoffId, name, { optional = false } = {}) {
  const filePath = path.join(realCheckout, ".relay", "handoff", handoffId, name);
  let real;
  try {
    real = fs.realpathSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (optional) return null;
      throw refuse("manifest_missing", name, error);
    }
    throw refuse("blob_unreadable", `${name} (${error?.code})`, error);
  }
  if (real !== realCheckout && !real.startsWith(`${realCheckout}${path.sep}`)) {
    throw refuse("blob_outside_checkout", name);
  }
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw refuse("blob_unreadable", `${name} (${error?.code})`, error);
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw refuse("blob_unreadable", `${name} is not a regular file`);
    if (stat.size > MAX_SEALED_BLOB_BYTES) throw refuse("blob_too_large", name);
    const buffer = Buffer.allocUnsafe(stat.size);
    let read = 0;
    while (read < stat.size) {
      const chunk = fs.readSync(fd, buffer, read, stat.size - read, read);
      if (chunk <= 0) break;
      read += chunk;
    }
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

// seal.mjs throws exactly three codes as bare Error messages; they are a closed
// vocabulary of its own and safe to surface. Anything else becomes the generic
// decrypt failure rather than leaking an unknown message.
const SEAL_REASONS = new Set(["seal_bad_magic", "seal_truncated", "seal_decrypt_failed"]);

function openSealedBlob(privateKeyPem, sealed) {
  try {
    return openSealed(privateKeyPem, sealed);
  } catch (error) {
    const code = SEAL_REASONS.has(error?.message) ? error.message : "seal_decrypt_failed";
    throw refuse(code, undefined, error);
  }
}

// ---------------------------------------------------------------------------
// The manifest: attacker-chosen, so allow-listed, type-checked and bounded
// BEFORE anything persists it, serves it over `GET /v1/handoffs/:id`, fans it
// out over SSE, or hands it to importSession.

function boundedString(value, max, field, { multiline = false } = {}) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw refuse("manifest_invalid", `${field} must be a string`);
  const stripped = multiline
    ? value.replace(/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/g, " ")
    : value.replace(/[\0-\x1f\x7f]/g, " ");
  return clip(stripped, max);
}

function boundedInteger(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw refuse("manifest_invalid", `${field} must be a number`);
  }
  return Math.trunc(value);
}

function parseManifest(bytes, { id }) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw refuse("manifest_too_large");
  let raw;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw refuse("manifest_unreadable", "not valid JSON", error);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw refuse("manifest_invalid", "not an object");
  }
  if (raw.v !== 1) throw refuse("unsupported_manifest_version");
  // The manifest is sealed to this node and states which handoff it is. If it
  // disagrees with the descriptor the transfer is not what the control plane
  // said it was.
  if (raw.id !== id) throw refuse("manifest_id_mismatch");

  const wipSource = raw.wip === undefined || raw.wip === null ? {} : raw.wip;
  if (typeof wipSource !== "object" || Array.isArray(wipSource)) {
    throw refuse("manifest_invalid", "wip must be an object");
  }

  return {
    v: 1,
    id,
    harness: boundedString(raw.harness, 32, "harness"),
    sessionId: boundedString(raw.sessionId, 128, "sessionId"),
    sessionFormat: boundedString(raw.sessionFormat, 32, "sessionFormat"),
    title: boundedString(raw.title, MAX_TITLE, "title"),
    repo: boundedString(raw.repo, MAX_NAME, "repo"),
    baseBranch: boundedString(raw.baseBranch, MAX_NAME, "baseBranch"),
    branch: boundedString(raw.branch, MAX_NAME, "branch"),
    cwd: boundedString(raw.cwd, MAX_PATHISH, "cwd"),
    machine: boundedString(raw.machine, 128, "machine"),
    createdAt: boundedInteger(raw.createdAt, "createdAt"),
    wip: {
      files: boundedInteger(wipSource.files, "wip.files"),
      insertions: boundedInteger(wipSource.insertions, "wip.insertions"),
      deletions: boundedInteger(wipSource.deletions, "wip.deletions"),
      summary: boundedString(wipSource.summary, MAX_SUMMARY, "wip.summary", { multiline: true }),
    },
    excerpt: boundedString(raw.excerpt, MAX_EXCERPT, "excerpt", { multiline: true }),
  };
}

// ---------------------------------------------------------------------------
// Announcements. None of these may throw: they are the thing that makes a
// failure visible, so a failure inside them must not become a new silence.

function safeAudit(event, extra) {
  try {
    // appendAudit's second argument is a JOB — passing a handoff there writes
    // the handoff id into the `jobId` column and makes audit correlation by job
    // id silently wrong. Handoff ids go in `handoffId`, explicitly.
    appendAudit(event, null, extra);
  } catch {
    /* the audit log is best-effort; never let it mask the event it describes */
  }
}

function safeEmit(name, data) {
  try {
    emitEvent(name, data);
  } catch (error) {
    safeAudit("handoff_emit_failed", { event: name, detail: operatorDetail(error) });
  }
}

// `postEvent` is a plain function that signs and writes a seq file BEFORE it
// returns a promise, so a synchronous throw escapes a trailing `.catch()`
// entirely. The call itself is inside the try for that reason.
async function safePostEvent(cloud, type) {
  try {
    await cloud?.postEvent?.(type);
  } catch {
    /* the push is best-effort; the local event and the record already landed */
  }
}

function persist(record) {
  try {
    store.saveHandoff(record);
    return true;
  } catch (error) {
    safeAudit("handoff_persist_failed", {
      handoffId: record?.id ?? null,
      state: record?.state ?? null,
      detail: operatorDetail(error),
    });
    return false;
  }
}

function readHandoff(id) {
  try {
    return store.getHandoff(id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pickup.

function baseRecord(id, descriptor, existing) {
  // store.saveHandoff requires non-empty repo/branch strings. When the
  // descriptor's own are unusable we still persist the record — a handoff that
  // fails validation must not vanish from `GET /v1/handoffs` — so the fields
  // say plainly that they were not usable rather than echoing attacker input.
  const repo = isSafeRepo(descriptor?.repo) ? descriptor.repo : existing?.repo || "(invalid)";
  const branch = isSafeBranch(descriptor?.branch) ? descriptor.branch : existing?.branch || "(invalid)";
  return {
    id,
    state: "importing",
    repo,
    branch,
    workspaceId: existing?.workspaceId ?? null,
    provider: null,
    resumeSessionId: null,
    primedPrompt: null,
    title: existing?.title || branch,
    manifest: null,
    lastJobId: existing?.lastJobId ?? null,
    error: null,
    createdAt: existing?.createdAt || nowIso(),
    updatedAt: nowIso(),
  };
}

async function announceReady(record, cloud) {
  safeAudit("handoff_ready", { handoffId: record.id, repo: record.repo, provider: record.provider });
  safeEmit("handoff.ready", {
    id: record.id,
    repo: record.repo,
    title: record.title,
    provider: record.provider,
  });
  await safePostEvent(cloud, "handoff.ready");
  return record;
}

async function announceFailed(base, reason, detail, cloud) {
  const failed = { ...base, state: "failed", error: reason, updatedAt: nowIso() };
  persist(failed);
  safeAudit("handoff_failed", { handoffId: base.id, repo: base.repo, reason, detail });
  safeEmit("handoff.failed", { id: base.id, repo: base.repo, error: reason });
  await safePostEvent(cloud, "handoff.failed");
  return failed;
}

// An id that is not path-safe is not a store key either, so there is no record
// to move to a terminal state — but the failure is still announced, never
// dropped, and the raw id never leaves this process.
async function announceUnrecordable(descriptor, error, cloud) {
  const reason = publicReason(error);
  safeAudit("handoff_failed", {
    handoffId: null,
    reason,
    detail: operatorDetail(error),
    repo: isSafeRepo(descriptor?.repo) ? descriptor.repo : null,
  });
  safeEmit("handoff.failed", { id: null, repo: null, error: reason });
  await safePostEvent(cloud, "handoff.failed");
  return { id: null, state: "failed", error: reason };
}

// Create the staging directory and start the clone INSIDE it, all pinned.
//
// This is the whole of property 1. git resolves its destination argument by
// path, from `/`, every time — so any destination we can name, an attacker can
// re-point between our last check and git's first write. That is exactly how a
// whole repository landed outside the jail last round, and no amount of
// checking before or after the clone can fix it.
//
// Here nothing above the destination is ever named again:
//
//   chdir(realRoot)            one path resolution, verified by getcwd
//   mkdir("<random>")          relative -> lands in the pinned root, or fails
//   chdir("<random>")          relative, verified by getcwd
//   spawn(git, ..., ".")       the child inherits the pinned inode
//
// The 128-bit random name is not the defence — the pinning is — but it does
// mean an attacker cannot even begin without first reading the name back out
// of the root, and by then the cwd is already pinned.
//
// Returns the still-running clone. The caller awaits it OUTSIDE the pinned
// block, because holding a process-global cwd across an await (or across a
// minutes-long clone) is exactly the kind of side effect that has no business
// in a daemon.
function startClone(realRoot, { branch, repo, remoteUrlFor, execFileImpl, runHome }) {
  const name = `.relayd-handoff-${crypto.randomBytes(16).toString("hex")}`;
  const dir = path.join(realRoot, name);
  const started = withPinnedCwd(realRoot, realRoot, () => {
    try {
      fs.mkdirSync(name, 0o700);
    } catch (error) {
      throw refuse("checkout_create_failed", `cannot create the staging directory (${error?.code})`, error);
    }
    // From here a failure must take the directory back out with it; the caller
    // cannot, because it does not yet have a handle.
    try {
      const planted = fs.lstatSync(name);
      if (!planted.isDirectory() || planted.isSymbolicLink()) {
        throw refuse("checkout_escaped_jail", "the staging directory is not a directory");
      }
      return withPinnedCwd(name, dir, () => {
        const pinned = fs.statSync(".");
        if (!sameInode(pinned, planted)) {
          throw refuse("checkout_escaped_jail", "the staging directory was swapped before the clone started");
        }
        const pending = execFileImpl(
          gitBin,
          [
            "clone", "--quiet", "--branch", branch, "--single-branch", "--depth", "50", "--no-tags",
            remoteUrlFor(repo), ".",
          ],
          {
            env: { ...process.env, HOME: runHome, GIT_TERMINAL_PROMPT: "0" },
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: GIT_MAX_BUFFER,
          },
        );
        return { pending, handle: { name, dir, dev: pinned.dev, ino: pinned.ino } };
      });
    } catch (error) {
      try {
        removePinnedEntry(name);
      } catch {
        /* the cleanup must not replace the failure that caused it */
      }
      throw error;
    }
  });
  return started;
}

// Everything between pickup and completion. Returns a ready record or throws —
// there is no third outcome and no path around the caller's catch.
async function runImport(id, descriptor, base, options, adoptCheckout) {
  // No `cloud` here on purpose: this function does the work and either returns
  // a ready record or throws. Announcing — audit, local event, cloud post — is
  // the caller's single settle point, so there is no second place a handoff can
  // be declared finished from.
  const { baseDir, runHome, execFileImpl, remoteUrlFor } = options;
  const repo = assertSafeRepo(descriptor?.repo);
  const branch = assertSafeBranch(descriptor?.branch);

  if (!persist(base)) throw refuse("store_write_failed");
  safeAudit("handoff_importing", { handoffId: id, repo, branch });

  const realRoot = resolveJailRoot();
  const finalName = checkoutDirName(id);
  const { pending, handle } = startClone(realRoot, { branch, repo, remoteUrlFor, execFileImpl, runHome });

  let checkout = null;
  let publishAttempted = false;
  try {
    try {
      await pending;
    } catch (error) {
      throw refuse("clone_failed", undefined, error);
    }
    publishAttempted = true;
    checkout = publishCheckout(realRoot, handle, finalName);
    adoptCheckout(checkout);
  } finally {
    // Nothing this block created survives a failure: not the staging directory
    // (renamed away on success, removed otherwise) and not the stable name,
    // which a rename may have half-landed on before a verification refused it.
    if (!checkout) {
      removeStagingIfOurs(realRoot, handle);
      if (publishAttempted) removeQuietly(path.join(realRoot, finalName));
    }
  }

  const privateKeyPem = readEncPrivateKeyPem(baseDir ? identityPaths(baseDir) : identityPaths());
  if (!privateKeyPem) throw refuse("no_encryption_key");

  const manifest = parseManifest(
    openSealedBlob(privateKeyPem, readSealedBlob(checkout, id, "manifest.enc")),
    { id },
  );
  const sessionBlob = readSealedBlob(checkout, id, "session.enc", { optional: true });
  const sessionBytes = sessionBlob === null ? null : openSealedBlob(privateKeyPem, sessionBlob);

  let staged;
  try {
    staged = importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath: checkout });
  } catch (error) {
    // sessionimport.mjs owns its own jail and its own typed refusals; its codes
    // are useful to an operator but the client sees only that staging failed.
    throw refuse("session_staging_failed", error?.code || undefined, error);
  }

  // Test-only seam: lets a test simulate, deterministically, the same same-uid
  // race this whole module exists to defend against — swapping the published
  // checkout for a symlink out of the jail — in the narrow window right
  // before registration, without needing to actually win a race. A no-op in
  // production.
  options.beforeWorkspaceRegistration?.(checkout);

  // Registered LAST, so a failure earlier never leaves an attacker-supplied
  // clone listed as a browsable workspace. This is NOT unreachable by
  // construction: containment was proved at publish time, above, not here.
  // browseWorkspaceForPath re-resolves `checkout` from `/` and returns null
  // the moment that resolution leaves the browse root — reachable by exactly
  // the same-uid attacker who can already rename or symlink a path component
  // between publish and this call, which is the premise of this entire
  // module's threat model, not a hypothetical.
  const workspace = browseWorkspaceForPath(checkout, { materialize: true });
  if (!workspace) throw refuse("workspace_registration_failed");

  const record = {
    ...base,
    state: "ready",
    workspaceId: workspace.id,
    provider: staged.provider,
    resumeSessionId: staged.resumeSessionId,
    primedPrompt: staged.primedPrompt,
    title: manifest.title || base.branch,
    manifest,
    error: null,
    updatedAt: nowIso(),
  };
  if (!persist(record)) throw refuse("store_write_failed");
  return record;
}

async function importHandoff(descriptor, options = {}) {
  const resolved = {
    cloud: options.cloud ?? null,
    baseDir: options.baseDir,
    runHome: options.runHome ?? configuredRunHome,
    execFileImpl: options.execFileImpl ?? execFileEscalating,
    remoteUrlFor: options.remoteUrlFor ?? ((repo) => `https://github.com/${repo}.git`),
    beforeWorkspaceRegistration: options.beforeWorkspaceRegistration,
  };

  let id;
  try {
    id = assertSafeHandoffId(descriptor?.id);
  } catch (error) {
    return announceUnrecordable(descriptor, error, resolved.cloud);
  }

  const existing = readHandoff(id);
  if (existing && existing.state === "ready") return existing;

  const base = baseRecord(id, descriptor, existing);

  // The terminal-state guarantee, in one place: whatever happens between here
  // and the ready record — a hostile manifest, a store failure, ENOSPC while
  // staging, a lost race on the checkout — ends as exactly one announcement,
  // and anything created on the way out is removed.
  let checkout = null;
  let record = null;
  let failure = null;
  try {
    record = await runImport(id, descriptor, base, resolved, (created) => {
      checkout = created;
    });
  } catch (error) {
    failure = { reason: publicReason(error), detail: operatorDetail(error) };
  }
  if (failure) {
    removeQuietly(checkout);
    return announceFailed(base, failure.reason, failure.detail, resolved.cloud);
  }
  return announceReady(record, resolved.cloud);
}

// ---------------------------------------------------------------------------
// Continue.

// jobId -> handoffId for every job this module enqueued, so that a SECOND
// continue (which moves the record's `lastJobId` on) can no longer orphan the
// first job's push-back — that used to return null in complete silence, with
// the first run's commits never pushed and nothing saying so.
const JOB_INDEX_LIMIT = 256;
const jobIndex = new Map();

function rememberJob(jobId, handoffId) {
  jobIndex.set(jobId, handoffId);
  while (jobIndex.size > JOB_INDEX_LIMIT) jobIndex.delete(jobIndex.keys().next().value);
}

// Every handoff checkout is registered as a DYNAMIC workspace under the browse
// root, and workspaces.mjs derives that id from the directory name, so it
// always starts with "dir-handoff-". completeHandoffJob runs on EVERY job
// completion in the daemon, and the previous implementation read and
// JSON.parsed every handoff record on each one; this is the O(1) filter that
// keeps an ordinary job from paying for that.
function isHandoffWorkspaceId(workspaceId) {
  return typeof workspaceId === "string" && workspaceId.startsWith("dir-handoff-");
}

function handoffIdForJob(job) {
  const cached = jobIndex.get(job.id);
  if (cached) return cached;
  if (!isHandoffWorkspaceId(job.workspaceId)) return null;
  // A job enqueued before a restart is not in the cache; the store still knows.
  try {
    const match = store.listHandoffs().find((entry) => entry.lastJobId === job.id);
    return match ? match.id : null;
  } catch {
    return null;
  }
}

function activeJobFor(record) {
  if (typeof record?.lastJobId !== "string") return null;
  const job = jobs.get(record.lastJobId);
  if (!job || TERMINAL_JOB_STATUSES.has(job.status)) return null;
  return job;
}

async function continueHandoff(id, { prompt = null, certSubject = null } = {}) {
  // store.getHandoff throws its typed invalid-id error for a malformed id;
  // additions.mjs turns that into the same clean 404 as an unknown id.
  const record = store.getHandoff(id);
  if (!record) throw Object.assign(new Error("handoff not found"), { status: 404 });
  if (record.state !== "ready") throw Object.assign(new Error("handoff is not ready"), { status: 409 });
  // One in-flight job per handoff. Without this a second continue overwrote
  // lastJobId, orphaning the first job's push-back, and two harnesses ran
  // concurrently in one checkout.
  if (activeJobFor(record)) {
    throw Object.assign(new Error("a job is already running for this handoff"), { status: 409 });
  }

  const job = enqueueJob(
    {
      workspaceId: record.workspaceId,
      provider: record.provider,
      prompt: prompt || record.primedPrompt || "Continue where the handed-off session left off.",
      resumeSessionId: record.resumeSessionId || undefined,
    },
    certSubject,
  );

  rememberJob(job.id, record.id);
  persist({ ...record, lastJobId: job.id, updatedAt: nowIso() });
  return job;
}

// ---------------------------------------------------------------------------
// Push-back.
//
// A handoff job's commits belong on the handoff branch, so a successful run
// commits and pushes there — never force, never elsewhere.
//
// WHAT MAY NOT RIDE ALONG. The previous implementation ran `git add -A`, and a
// `.env` holding a live API key plus `.secrets/harness-token.json` were pushed
// to the GitHub branch, where history is not revocable. The CLI side of the
// handoff relies on `.gitignore` for the same problem; that is not sufficient
// here, for three reasons:
//
//  1. `.gitignore` is written by the repository's authors for THEIR laptops. It
//     cannot know about files this sandbox creates — a harness token, an agent's
//     scratch `.env` — because those never exist on the machine the ignore file
//     was written on.
//  2. The `.gitignore` in the checkout arrives over the network on the handoff
//     branch. It is attacker-supplied data, so relying on it is relying on the
//     attacker to opt out.
//  3. `git add -A` stages a TRACKED file's modifications regardless of any
//     ignore rule, so a repo that tracks `.env.example` and an agent that fills
//     it in defeats the ignore file entirely.
//
// So the policy is code, applied to an explicit file list, and then re-checked
// against what actually reached the index. `.gitignore` remains a first filter
// (git status honours it), never the control.
//
// Two honest limits, stated rather than assumed away: (m-6) a SYMLINK whose
// name isn't secret-shaped is pushed as a symlink object — its target PATH
// (which can be a host path) reaches the remote even though its bytes never
// do. (m-7) this is a NAME policy, not a content scanner: a secret pasted
// into a file whose name doesn't match SECRET_PATH_RULES (e.g. notes.md)
// is pushed. Both are inherent to matching by shape rather than reading
// every byte of every file; worth knowing before assuming this list is a
// content-aware secret scanner.
//
// >>> BEGIN SHARED SECRET-PATH POLICY — CANONICAL COPY >>>
// One policy, one spelling. This is the answer to "what may leave the
// machine", and BOTH halves of the handoff need it: the sandbox pushing back
// (below) and the laptop pushing out (`relay handoff`, which reached GitHub
// with a .env, a tracked-and-modified .env.example and an .ssh/id_rsa before
// this text existed there). product/cli/src/commands/handoff.mjs vendors
// everything between these two markers BYTE FOR BYTE — the same arrangement
// seal.mjs already uses — and product/cli/test/handoff.test.mjs fails loudly
// if the two copies drift. Edit this copy, then paste it over the other one;
// two spellings of this contract WILL diverge, and the divergence is a live
// key in unrevocable history.
const SECRET_PATH_RULES = [
  /(^|\/)\.env($|[.\-_])/i,
  /(^|\/)\.envrc$/i,
  /(^|\/)\.secrets?(\/|$)/i,
  /(^|\/)secrets?\.(json|ya?ml|toml|ini|txt|env|enc)$/i,
  /(^|\/)\.git-credentials$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.pypirc$/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.docker\/config\.json$/i,
  /(^|\/)\.config\/gh(\/|$)/i,
  /(^|\/)\.claude\/\.credentials\.json$/i,
  /(^|\/)\.codex\/auth\.json$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)($|\.)/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /(^|\/)credentials(\.[A-Za-z0-9]+)?$/i,
  /(^|\/)service-account[^/]*\.json$/i,
  /(^|\/)[^/]*\.tfstate($|\.)/i,
];

function isSecretPath(candidate) {
  return SECRET_PATH_RULES.some((rule) => rule.test(candidate));
}
// <<< END SHARED SECRET-PATH POLICY <<<

function splitNulList(text) {
  return String(text)
    .split("\0")
    .filter((entry) => entry.length > 0);
}

// `git status --porcelain=v1 -z` records are `XY<space><path>`, and a rename or
// copy carries a second NUL-separated origin path. -z means paths are literal,
// never quoted, so there is nothing to unescape.
function parsePorcelainZ(text) {
  const fields = String(text).split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    paths.push(field.slice(3));
    if (status[0] === "R" || status[0] === "C") index += 1; // consume the origin path
  }
  return paths;
}

// Resolve the checkout for a push. The push WRITES (commit objects, refs), so
// containment matters exactly as much as it does on the way in.
function verifiedCheckout(handoffId) {
  let expected;
  try {
    // A record written by an older, laxer build can carry an id this module
    // would no longer accept. That must read as "no checkout" — the caller then
    // announces it — not as a throw that jobs.mjs's `.catch(() => null)`
    // swallows on the way out of finishJob.
    expected = checkoutPathFor(handoffId);
  } catch {
    return null;
  }
  let entry;
  try {
    entry = fs.lstatSync(expected);
  } catch {
    return null;
  }
  if (!entry.isDirectory()) return null;
  let real;
  try {
    real = fs.realpathSync(expected);
  } catch {
    return null;
  }
  if (real !== expected || !resolvedPathWithinRoot(real)) return null;
  if (!fs.existsSync(path.join(real, ".git"))) return null;
  return real;
}

function announcePushOutcome(record, outcome, extra = {}) {
  const pushed = outcome === "pushed";
  // The one gate. Everything this function can put in front of a client — the
  // local SSE event and `record.error`, which additions.mjs serves verbatim to
  // the phone — is drawn from PUBLIC_REASONS here, so a caller that invents a
  // reason (or interpolates a detail into one) gets `internal_error` instead
  // of a route to the phone. This used to persist `extra.reason` raw.
  const reason = pushed ? null : publicCode(extra.reason || "push_failed");
  safeAudit(pushed ? "handoff_pushed" : "handoff_push_failed", {
    handoffId: record.id,
    branch: record.branch,
    ...extra,
  });
  safeEmit(pushed ? "handoff.pushed" : "handoff.push_failed", {
    id: record.id,
    repo: record.repo,
    branch: record.branch,
    jobId: extra.jobId ?? null,
    // A push failure is not a handoff failure: the checkout is still there and
    // still resumable. The record stays `ready` and carries the reason, so the
    // phone stops being told the work was pushed when it was not.
    error: reason,
  });
  // Re-read rather than spread the `record` snapshot the caller captured at
  // the top of completeHandoffJob: a `continue` landing while `git push` was
  // still running (which can take seconds) updates `lastJobId` in the store
  // in the meantime, and persisting the stale snapshot here would silently
  // revert that the instant the push finishes. Only the fields THIS function
  // owns (error, updatedAt) are ever changed; everything else reflects
  // whatever is actually in the store right now.
  const current = readHandoff(record.id) || record;
  persist({ ...current, error: reason, updatedAt: nowIso() });
  // The cloud's node-event schema knows only handoff.ready / handoff.failed
  // (cloud/src/notify.js KNOWN_TYPES), so a push result has no push channel; it
  // reaches the phone over the local SSE feed and the record instead.
}

async function completeHandoffJob(job, options = {}) {
  // Test-only seam, mirroring the one runImport already takes: lets a test
  // observe or interleave with the exact argv/timing git sees, without
  // needing to win a real race. Production always uses execFileEscalating.
  const execFileImpl = options.execFileImpl ?? execFileEscalating;
  const jobId = typeof job?.id === "string" ? job.id : null;
  if (!jobId) return null;
  const handoffId = handoffIdForJob(job);
  if (!handoffId) return null; // an ordinary job, not a handoff job — say nothing
  const record = readHandoff(handoffId);
  if (!record) {
    safeAudit("handoff_push_skipped", { handoffId, jobId, reason: "record_missing" });
    return { branch: null, pushed: false, reason: "record_missing" };
  }
  if (job.status !== "succeeded") {
    // Through the gate here as well as in announcePushOutcome, so the value
    // this function RETURNS is the same closed-vocabulary word it persisted —
    // `job.status` comes from the jobs engine's own set today, and this module
    // must not be the place where that assumption is load-bearing.
    const raw = `job_${typeof job.status === "string" ? job.status : "unknown"}`;
    const reason = publicCode(raw);
    // Nothing is LOST by closing the vocabulary: when the gate had to rewrite
    // the reason, the exact status still reaches the operator's channel, which
    // is where attacker-influenced text is allowed to go.
    announcePushOutcome(record, "skipped", {
      jobId, reason, ...(reason === raw ? {} : { detail: redactUntrusted(raw) }),
    });
    return { branch: record.branch, pushed: false, reason };
  }

  const checkout = verifiedCheckout(record.id);
  if (!checkout) {
    announcePushOutcome(record, "skipped", { jobId, reason: "checkout_missing" });
    return { branch: record.branch, pushed: false, reason: "checkout_missing" };
  }

  // GIT_LITERAL_PATHSPECS=1 turns off ALL pathspec magic — globs, and the
  // ":(...)"/"!"/leading-":" special syntax — for every call below. Without
  // it, `git add -- <paths from git status>` interprets those paths as
  // PATHSPECS, not filenames: a file named ":!work.txt" makes `git add --
  // ":!work.txt" "work.txt"` stage NOTHING (the exclusion wins), so no commit
  // is made, `git push` succeeds as a no-op, and the module reports
  // pushed:true while the agent's work never reached the remote — the one
  // place in this module a failure was silent. A file named "*" would
  // otherwise re-glob a path layer 1 withheld right back into the add list.
  const git = (...args) =>
    execFileImpl(gitBin, ["-C", checkout, ...args], {
      env: { ...process.env, HOME: configuredRunHome, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" },
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
    });
  // -c on every writing call: a gpg-signing config in runHome would otherwise
  // block on a passphrase prompt until the timeout fires.
  const commitGit = (...args) =>
    git("-c", "user.name=relayd", "-c", "user.email=relayd@localhost", "-c", "commit.gpgsign=false", ...args);

  try {
    // Whatever the harness left staged is discarded first, so the index that
    // gets committed is exactly the set this policy chose — not a set the
    // harness (or a hostile branch's hooks) pre-loaded.
    await git("reset", "-q");

    const candidates = parsePorcelainZ(
      (await git("status", "--porcelain=v1", "-z", "--untracked-files=all")).stdout,
    );
    const allowed = candidates.filter((entry) => !isSecretPath(entry));
    const withheld = candidates.filter((entry) => isSecretPath(entry));

    for (let index = 0; index < allowed.length; index += 200) {
      await git("add", "--", ...allowed.slice(index, index + 200));
    }

    // Second layer, and load-bearing TODAY, not defence against a future
    // divergence: layer 1 filters the paths `git status` reported, once, at
    // the start; this re-checks the paths that ACTUALLY reached the index.
    // Those are not the same input — a path `git status` reported as a plain
    // file can become a directory containing a secret in the window before
    // `git add` runs (the harness sharing this sandbox is exactly the
    // same-uid actor this module's threat model assumes), and git then
    // stages everything under it, under a name layer 1 never saw and so
    // never filtered. Deleting this check is exactly what turns that TOCTOU
    // into a live key on the remote's unrevocable history — see the "I-2"
    // test, which dies without it.
    const staged = splitNulList((await git("diff", "--cached", "--name-only", "-z")).stdout);
    const leaked = staged.filter((entry) => isSecretPath(entry));
    if (leaked.length > 0) {
      throw refuse("push_blocked_secret_staged", `${leaked.length} denied path(s) reached the index`);
    }

    if (withheld.length > 0) {
      safeAudit("handoff_push_withheld", {
        handoffId: record.id,
        jobId,
        withheld: withheld.slice(0, 20),
        count: withheld.length,
      });
    }

    if (staged.length > 0) await commitGit("commit", "-m", `relay: job ${jobId}`);
    // Fully-qualified two-sided refspec, never a bare branch name. `git push
    // origin <name>` treats a single positional argument as a REFSPEC, and a
    // leading "+" is a legal character in a real git ref name (unlike ":"
    // "^" "?" "*" "[", which check-ref-format already forbids) but is also
    // git's force-push prefix — "git push origin +main" force-pushes. Writing
    // the refspec out ourselves means an attacker-controlled branch name can
    // only ever be a REF COMPONENT, never syntax.
    await git("push", "origin", `refs/heads/${record.branch}:refs/heads/${record.branch}`);
    announcePushOutcome(record, "pushed", { jobId, withheld: withheld.length });
    return { branch: record.branch, pushed: true, withheld: withheld.length };
  } catch (error) {
    const reason = error?.code === "push_blocked_secret_staged" ? "push_blocked_secret" : "push_failed";
    announcePushOutcome(record, "failed", { jobId, reason, detail: operatorDetail(error) });
    return { branch: record.branch, pushed: false, reason };
  }
}

// ---------------------------------------------------------------------------
// The pickup loop.

function startHandoffLoop({ cloud, waitSec } = {}) {
  let stopped = false;
  let wake = null;

  // Always a real timer, never a bare resolved promise: a zero-length wait
  // still yields to the macrotask queue, which is what stops the degenerate
  // case (a poll that resolves without IO) from starving the event loop.
  // unref'd so it never holds the process open; cancelled by stop() so
  // shutdown does not wait out a backoff.
  const sleep = (ms) =>
    new Promise((resolve) => {
      if (stopped) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      timer.unref?.();
      wake = () => {
        clearTimeout(timer);
        wake = null;
        resolve();
      };
    });

  // RELAYD_HANDOFF_POLL_WAIT_SEC permits 0, which asks the cloud to answer
  // immediately; combined with the floor above that is merely wasteful rather
  // than fatal, but there is no reason to ask for it.
  const pollWaitSec = Math.max(
    MIN_POLL_WAIT_SEC,
    Number.isFinite(waitSec) ? Math.floor(waitSec) : MIN_POLL_WAIT_SEC,
  );

  (async () => {
    let backoffMs = 1000;
    while (!stopped) {
      const startedAt = Date.now();
      try {
        const descriptors = await cloud.pollHandoffs(pollWaitSec);
        if (!Array.isArray(descriptors)) throw refuse("cloud_poll_invalid", "not a list");
        backoffMs = 1000;
        // One cycle imports a bounded batch: a hostile control plane answering
        // with ten thousand descriptors must not turn one poll into ten
        // thousand clones. The rest are still pending and arrive next cycle —
        // and the truncation is recorded rather than silent.
        if (descriptors.length > MAX_POLL_BATCH) {
          safeAudit("handoff_poll_truncated", { offered: descriptors.length, taken: MAX_POLL_BATCH });
        }
        for (const descriptor of descriptors.slice(0, MAX_POLL_BATCH)) {
          if (stopped) break;
          try {
            await importHandoff(descriptor, { cloud });
          } catch (error) {
            // importHandoff is a settle function and should never throw. If it
            // ever does, it is an import failure and must not be mislabelled as
            // a poll failure — that mislabelling is what hid a wedged handoff
            // behind a "network problem" for an entire release.
            safeAudit("handoff_import_failed", { detail: operatorDetail(error) });
          }
        }
        await sleep(Math.max(0, POLL_FLOOR_MS - (Date.now() - startedAt)));
      } catch (error) {
        safeAudit("handoff_poll_failed", { detail: operatorDetail(error) });
        await sleep(backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      wake?.();
    },
  };
}

export {
  importHandoff,
  continueHandoff,
  completeHandoffJob,
  startHandoffLoop,
  checkoutPathFor,
  isSecretPath,
  // Exported so the jail's two load-bearing primitives have direct tests
  // instead of only being reachable through a race: `withPinnedCwd` is the
  // containment mechanism itself, and PUBLIC_REASONS is the closed vocabulary
  // that decides what a client is ever allowed to be told. execFileEscalating
  // is exported so its SIGKILL escalation can be tested directly, with a
  // short timeout, instead of waiting out the real 10-minute GIT_TIMEOUT_MS.
  withPinnedCwd,
  PUBLIC_REASONS,
  execFileEscalating,
};
