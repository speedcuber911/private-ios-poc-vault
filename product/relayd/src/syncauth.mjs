// relayd syncauth.mjs — install the operator's own credentials into the runner
// home so the sandbox can fetch their repo and run their subscriptions.
//
// Credentials arrive sealed to this node's key over the pairing rendezvous
// (see product/cloud/src/pairing.js, kind "sync-auth"/"session-index"): the
// control plane relays opaque ciphertext bytes and never sees a token.
// Opening the seal (openSealed + readEncPrivateKeyPem) happens in the caller
// that wires collectRendezvousBlob to installCredentialBundle — this module
// only ever sees already-decrypted JS values, and only ever WRITES them,
// never logs, echoes, or returns them from any function or route here.
//
// Every destination path below is a literal this module chose itself, never
// a name or path fragment taken from bundle content — the bundle only ever
// supplies file *contents*. writePrivateFile still resolves the real
// (symlink-following) path of the parent directory and compares it against
// the real path of the root it was told to write under, so a pre-planted
// symlink ANCESTOR (a poisoned .claude dir left by a prior tenant, say)
// fails closed instead of silently redirecting a credential write outside
// the runner home. That is the same defense-in-depth sessionimport.mjs's
// writeContainedFile uses for bundle-chosen names; here it guards a root
// that must never move, even though nothing here lets the bundle choose
// the name.
//
// The leaf itself gets a stronger guarantee than O_NOFOLLOW can offer.
// O_NOFOLLOW rejects a symlink at the final path component, but it says
// nothing about a HARD LINK: a hard link is not a distinct filesystem
// object with link-ness visible at the path level, it is a second name for
// the same inode, so opening an existing leaf — even with O_NOFOLLOW — can
// still write straight through a pre-planted hard link into a file the
// attacker already controls (and POSIX ignores the `mode` argument to
// `open` for a file that already existed, so its original, possibly
// world-readable permissions survive too). The fix is to never open an
// existing leaf name for writing at all: create a fresh file at a
// uniquely-named path with O_CREAT|O_EXCL|O_NOFOLLOW (which guarantees we
// created the inode — a hard link or symlink pre-planted at that exact
// random name is astronomically unlikely, and O_EXCL refuses to open
// through one anyway), set its mode and write its contents through the fd
// (a path-based redirect after open cannot touch an fd), fsync, and only
// then `rename` it onto the real leaf name. `rename` replaces whatever
// directory ENTRY was there — pre-existing file, hard link, or symlink —
// with our fresh inode; it never writes through it. A poisoned leaf ends
// up harmlessly replaced by a correctly-permissioned file this module
// itself created, instead of being written into. Same shape
// sessionimport.mjs's writeStagedFile uses for this exact reason.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { appendAudit } from "./audit.mjs";

const SUPPORTED_VERSION = 1;

// Ensures `root` exists (0700) and returns its REAL (symlink-resolved) path,
// once, so every file written under it can be checked against a fixed
// baseline rather than re-resolving (and re-trusting) the bundle's idea of
// where things live.
function ensurePrivateRoot(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

// Never unlink anything that is not still the exact inode we created —
// `unlink` is path-based, so identity is checked (by dev+ino) before it
// runs. If the path no longer leads to our staging file, it is left alone
// rather than deleting whatever a racing process put there instead.
function removeStagingFile(staging, dev, ino) {
  try {
    const leftover = fs.lstatSync(staging);
    if (leftover.isFile() && leftover.dev === dev && leftover.ino === ino) {
      fs.unlinkSync(staging);
    }
  } catch {
    /* already gone, or never existed */
  }
}

// Writes `contents` to `path.join(dir, filename)` in a way that can never
// deliver a single byte anywhere else, and never lands on an inode this
// call did not itself create. See the module header for why O_NOFOLLOW on
// the final leaf is not enough on its own.
function writeStagedFile(dir, filename, contents) {
  const target = path.join(dir, filename);
  const staging = path.join(dir, `.syncauth-${crypto.randomBytes(16).toString("hex")}.tmp`);

  // Best-effort, pre-write snapshot of whatever currently occupies `target`
  // — used only for the audit line below, never for any decision about
  // whether to proceed. A race here can't affect the write itself: rename()
  // further down is what actually determines the outcome, and it always
  // replaces the directory entry rather than writing through it (see the
  // module header). This is deliberately silent for the routine case (no
  // prior entry, or a prior regular file this module itself last wrote —
  // e.g. re-syncing credentials that already landed here before) and only
  // speaks up for the cases an operator would actually want to know about:
  // a pre-existing symlink or hard link at a credential destination.
  let priorKind = null;
  try {
    const prior = fs.lstatSync(target);
    if (prior.isSymbolicLink()) priorKind = "symlink";
    else if (prior.isFile() && prior.nlink > 1) priorKind = "hardlink";
    else if (!prior.isFile()) priorKind = "other";
  } catch {
    priorKind = null; // nothing there yet — the routine first-install case.
  }

  let fd;
  try {
    fd = fs.openSync(
      staging,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    throw new Error("credential_staging_failed");
  }

  let ok = false;
  let stagedDev = null;
  let stagedIno = null;
  try {
    const opened = fs.fstatSync(fd);
    stagedDev = opened.dev;
    stagedIno = opened.ino;
    if (!opened.isFile() || opened.nlink !== 1) {
      // Vanishingly unlikely given the random name, but if it ever happens
      // this is exactly the class of bug this whole function exists to
      // rule out — refuse loudly instead of writing.
      throw new Error("credential_staging_race");
    }

    // From here on, everything writes through the fd — an inode, not a
    // name — so nothing that happens to the path can redirect it.
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);

    const written = fs.fstatSync(fd);
    if (written.nlink !== 1 || written.dev !== stagedDev || written.ino !== stagedIno) {
      throw new Error("credential_staging_race");
    }
    ok = true;
  } finally {
    fs.closeSync(fd);
    if (!ok) removeStagingFile(staging, stagedDev, stagedIno);
  }

  // `rename` replaces the destination directory ENTRY — file, hard link, or
  // symlink — with our fresh inode. It never writes through whatever was
  // there, so a poisoned pre-existing leaf ends up harmlessly replaced.
  try {
    fs.renameSync(staging, target);
  } catch {
    removeStagingFile(staging, stagedDev, stagedIno);
    throw new Error("credential_publish_failed");
  }

  // Verify what actually landed: still a regular file, still a single
  // link, still the exact inode we staged, still 0600. This is what makes
  // a lost race at the very last instant loud instead of silent.
  const published = fs.lstatSync(target);
  if (
    !published.isFile() ||
    published.nlink !== 1 ||
    published.dev !== stagedDev ||
    published.ino !== stagedIno ||
    (published.mode & 0o777) !== 0o600
  ) {
    throw new Error("credential_publish_verification_failed");
  }

  // The write itself is already correct either way (rename replaces the
  // entry, never writes through it) — this is purely a signal for whoever
  // is watching the audit log. Path and category only, exactly like this
  // codebase's other appendAudit call sites; never contents.
  if (priorKind) {
    appendAudit("credential_destination_replaced", null, { path: target, priorKind });
  }
}

// Writes `contents` to `path.join(root, ...segments)`. `segments` are path
// components chosen entirely by the CALLER of this function (i.e. by this
// module's own code) — never by bundle content. Real-path-checks the parent
// directory against `root` so a symlinked ancestor cannot redirect the
// write outside the root, then delegates the leaf write to writeStagedFile,
// which is hardened against a poisoned leaf itself (symlink or hard link).
function writePrivateFile(root, segments, contents) {
  const resolvedRoot = ensurePrivateRoot(root);
  const dir = segments.length > 1 ? path.join(root, ...segments.slice(0, -1)) : root;
  if (dir !== root) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }

  const resolvedDir = fs.realpathSync(dir);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
    throw new Error("credential_path_escapes_root");
  }

  const filename = segments[segments.length - 1];
  writeStagedFile(resolvedDir, filename, contents);
}

// A non-empty string, or null. Bundle members are attacker-controlled until
// proven otherwise — a present-but-wrong-typed field (number, object, array)
// must not get stringified into a credential file; it is treated exactly
// like an absent field and lands in `skipped`.
function stringField(value) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// GETs the `device-blob` rendezvous slot (Task 10, product/cloud/src/pairing.js
// kind "sync-auth"/"session-index"). Returns the raw sealed bytes as-is —
// opening the seal is the caller's job (openSealed + readEncPrivateKeyPem),
// not this module's. The slot is put-once and TTL'd on the cloud side; this
// function does a single GET and neither retries around a 409/404 nor tries
// to make the slot behave like anything other than put-once.
async function collectRendezvousBlob({ cloudUrl, pairingId, authToken, fetchImpl = fetch }) {
  const base = `${String(cloudUrl).replace(/\/+$/, "")}/v1/pairing/sessions/${encodeURIComponent(pairingId)}`;
  const res = await fetchImpl(`${base}/device-blob`, { headers: { "x-pairing-auth": authToken } });
  if (res.status !== 200) throw new Error(`rendezvous_${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Installs an already-decrypted sync-auth bundle into the runner home.
// Every member is optional; an absent (or wrong-typed) member lands in
// `skipped` rather than being silently dropped, so the CLI can report
// honestly which credentials actually made it onto the sandbox. Cursor has
// no portable credential file and is never a bundle member — it is not
// listed in `installed` or `skipped` here, by design (v0 tells the operator
// to log in on the sandbox later, rather than pretending it synced).
function installCredentialBundle(bundle, { runHome, codexHome }) {
  if (bundle?.v !== SUPPORTED_VERSION) throw new Error("unsupported_bundle_version");
  if (bundle?.kind !== "sync-auth") throw new Error("unexpected_bundle_kind");

  const installed = [];
  const skipped = [];

  const githubToken = stringField(bundle.github?.token);
  if (githubToken) {
    writePrivateFile(runHome, [".git-credentials"], `https://x-access-token:${githubToken}@github.com\n`);
    writePrivateFile(runHome, [".gitconfig"], "[credential]\n\thelper = store\n");
    installed.push("github");
  } else {
    skipped.push("github");
  }

  const claudeCredentials = stringField(bundle.claude?.credentials);
  if (claudeCredentials) {
    writePrivateFile(runHome, [".claude", ".credentials.json"], claudeCredentials);
    installed.push("claude");
  } else {
    skipped.push("claude");
  }

  const codexAuth = stringField(bundle.codex?.auth);
  if (codexAuth) {
    writePrivateFile(codexHome, ["auth.json"], codexAuth);
    installed.push("codex");
  } else {
    skipped.push("codex");
  }

  return { installed, skipped };
}

const MAC_SESSIONS_FILE = "mac-sessions.json";

function macSessionsPath(dataDir) {
  return path.join(dataDir, MAC_SESSIONS_FILE);
}

// Persists the "On your Mac" session index the phone renders. Only the
// allow-listed fields below are ever written — no transcript, no prompt, no
// credential can ride along even if a compromised/buggy sender put one in
// the bundle, because nothing but these five strings per session is copied.
function saveMacSessions(bundle, { dataDir }) {
  if (bundle?.v !== SUPPORTED_VERSION) throw new Error("unsupported_bundle_version");
  if (bundle?.kind !== "session-index") throw new Error("unexpected_bundle_kind");

  const sessions = Array.isArray(bundle.sessions) ? bundle.sessions.slice(0, 200) : [];
  const payload = {
    machine: bundle.machine || null,
    updatedAt: bundle.updatedAt || null,
    sessions: sessions.map((session) => ({
      id: String(session.id),
      harness: String(session.harness),
      title: String(session.title || ""),
      repo: String(session.repo || ""),
      lastActive: String(session.lastActive || ""),
    })),
  };
  writePrivateFile(dataDir, [MAC_SESSIONS_FILE], JSON.stringify(payload, null, 2));
}

// Returns the last-saved session index, or null when none has ever been
// written (never posted, or the daemon's data dir was just created).
function readMacSessions({ dataDir }) {
  try {
    return JSON.parse(fs.readFileSync(macSessionsPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

export { collectRendezvousBlob, installCredentialBundle, saveMacSessions, readMacSessions };
