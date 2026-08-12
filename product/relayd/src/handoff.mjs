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
//
//   1. Nothing this module creates may exist outside the jail
//      (workspaceBrowseRoot) at ANY instant — not transiently, not on a
//      failure path.
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
// RESIDUAL, stated rather than hidden: a same-uid attacker can `rename` a
// directory we created at any moment, and the bytes follow the inode. That is
// not a write to a path of THEIR choosing through OUR privileges — they moved a
// directory they could equally have moved a second later — and it can never be
// published, because the identity check at (e) refuses it. No sequence of
// symlinks, renames or unlinks can make this module write through a name the
// attacker controls.
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
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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

const execFileAsync = promisify(execFile);

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
]);

function publicReason(error) {
  const code = error?.code;
  return typeof code === "string" && PUBLIC_REASONS.has(code) ? code : "internal_error";
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
    fs.unlinkSync(name);
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

  // Registered LAST, so a failure earlier never leaves an attacker-supplied
  // clone listed as a browsable workspace.
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
    execFileImpl: options.execFileImpl ?? execFileAsync,
    remoteUrlFor: options.remoteUrlFor ?? ((repo) => `https://github.com/${repo}.git`),
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
    error: pushed ? null : extra.reason || "push_failed",
  });
  persist({ ...record, error: pushed ? null : extra.reason || "push_failed", updatedAt: nowIso() });
  // The cloud's node-event schema knows only handoff.ready / handoff.failed
  // (cloud/src/notify.js KNOWN_TYPES), so a push result has no push channel; it
  // reaches the phone over the local SSE feed and the record instead.
}

async function completeHandoffJob(job) {
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
    const reason = `job_${typeof job.status === "string" ? job.status : "unknown"}`;
    announcePushOutcome(record, "skipped", { jobId, reason });
    return { branch: record.branch, pushed: false, reason };
  }

  const checkout = verifiedCheckout(record.id);
  if (!checkout) {
    announcePushOutcome(record, "skipped", { jobId, reason: "checkout_missing" });
    return { branch: record.branch, pushed: false, reason: "checkout_missing" };
  }

  const git = (...args) =>
    execFileAsync(gitBin, ["-C", checkout, ...args], {
      env: { ...process.env, HOME: configuredRunHome, GIT_TERMINAL_PROMPT: "0" },
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

    // Second layer, and the one that fails closed: whatever the pathspecs and
    // git's own expansion actually produced is checked again before a commit
    // object exists. If a denied path is in the index here, nothing is pushed.
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
    await git("push", "origin", record.branch);
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
  // that decides what a client is ever allowed to be told.
  withPinnedCwd,
  PUBLIC_REASONS,
};
