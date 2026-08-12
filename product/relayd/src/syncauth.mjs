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
// the real path of the root it was told to write under, and opens the leaf
// with O_NOFOLLOW, so a pre-planted symlink anywhere under the root (a
// poisoned .claude dir left by a prior tenant, say) fails closed instead of
// silently redirecting a credential write outside the runner home. That is
// the same defense-in-depth sessionimport.mjs's writeContainedFile uses for
// bundle-chosen names; here it guards a root that must never move, even
// though nothing here lets the bundle choose the name.
import fs from "node:fs";
import path from "node:path";

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

// Writes `contents` to `path.join(root, ...segments)`. `segments` are path
// components chosen entirely by the CALLER of this function (i.e. by this
// module's own code) — never by bundle content. Real-path-checks the parent
// directory against `root` and opens the leaf with O_NOFOLLOW so a symlink
// anywhere in between, or at the leaf itself, cannot redirect the write.
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
  const target = path.join(dir, filename);

  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if (err.code === "ELOOP") {
      throw new Error("credential_write_refused_symlink");
    }
    throw err;
  }
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
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
