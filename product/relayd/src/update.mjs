// relayd update.mjs — the self-update engine (spec
// docs/superpowers/specs/2026-09-21-relayd-release-subscription.md).
//
// The control plane announces a fact — "stable is now version X" — on the
// long-poll relayd already holds open. Everything after that happens here, on
// the node, because it has to: a BYO machine is behind NAT, the control plane
// holds no inbound path to it and no credential that authorises code
// execution on it, and this file must not create one.
//
// THE TRUST BOUNDARY, stated once because every function below depends on it:
// the release signing key is OFFLINE and is not present on the control-plane
// host. `install.sh` bakes the PUBLIC half into the node, and nothing is
// unpacked until a detached Ed25519 signature over the artifact's sha256
// digest verifies against it. A compromised control plane can therefore
// withhold an update, delay one, or point at a mirror — denial and delay —
// but it cannot author code a node will execute. The refusals below (no
// downgrade, honour minVersion, honour a pin, skip a poisoned digest) are what
// bound the attacks that remain, so they are not optional hardening.
//
// The apply sequence is deliberately the same shape as
// product/cloud/deploy/install.sh's, because that shape is already proven in
// this repository: decide, download, verify, stage beside the running copy,
// wait until the node is idle, flip a symlink, restart, check your own health,
// roll back if that check fails.
//
// Everything that touches the filesystem, spawns a process, restarts a
// service or dials the network is behind an injectable seam. That is not
// abstraction for its own sake: the decision logic here is the part that must
// be provably right, and it cannot be tested at all if exercising it needs
// root, systemd and a real tarball.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  host,
  port,
  servesTls,
  isWildcardHost,
  bracketHost,
  writeFileAtomic,
  releaseChannel,
  autoUpdate,
  updateRoot as configuredUpdateRoot,
  updateStateDir as configuredStateDir,
  releasePublicKeyFile as configuredPublicKeyFile,
  updateDrainWaitSec,
  updateHealthWaitSec,
  updateServiceName,
} from "./config.mjs";
import { appendAudit } from "./audit.mjs";
import { version as runningBuildVersion, readBuildIdentity, cleanVersion } from "./version.mjs";

const execFileAsync = promisify(execFile);

// A relayd tarball is source plus a package manifest — tens of kilobytes. The
// ceiling exists so a compromised or misconfigured release host cannot make a
// node buffer an arbitrary amount into memory before the digest is even
// checked.
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

// Poisoned entries are kept so a bad artifact is not retried in a loop against
// an announcement that re-states itself every poll. Bounded because this is a
// small state file, not a history: the oldest entries are the least useful,
// since the digest they name has long since stopped being announced.
const MAX_POISON_ENTRIES = 64;

const RELEASE_SIGNATURE_BYTES = 64;

// ---------------------------------------------------------------------------
// Version ordering
//
// A deliberate SUBSET of semver rather than a semver implementation: dotted
// numeric release segments, an optional `-prerelease` tail, an optional
// `+build` tail that is ignored for ordering. That is exactly what a git tag
// in this repository produces, and the subset is what keeps the refusal below
// honest — anything this cannot parse is refused, never guessed at, because
// "unparseable" must never accidentally compare as "newer".
const VERSION_PATTERN = /^(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?(?:-([0-9A-Za-z][0-9A-Za-z.-]{0,47}))?(?:\+[0-9A-Za-z][0-9A-Za-z.-]{0,47})?$/;

function parseVersion(value) {
  if (typeof value !== "string") return null;
  const match = VERSION_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    release: [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

// A release outranks its own prereleases (0.2.0 > 0.2.0-rc.1), and a shorter
// prerelease outranks a longer one with the same prefix. Numeric identifiers
// compare numerically so rc.2 < rc.10.
function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (Number(a) !== Number(b)) return Number(a) < Number(b) ? -1 : 1;
      continue;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

// -1 / 0 / 1, or null when either side is unparseable. Callers MUST handle
// null rather than coercing it: `null < 0` is false and `null > 0` is false,
// so a coerced comparison silently reads as "equal" and would let an
// unparseable announcement look like the version already running.
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index++) {
    if (a.release[index] !== b.release[index]) return a.release[index] < b.release[index] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

// ---------------------------------------------------------------------------
// Key and digest handling — node:crypto only.

function decodeRawKeyBytes(text) {
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const bytes = Buffer.from(text, "base64url");
    return bytes.length === 32 ? bytes : null;
  }
  return null;
}

// The release trust anchor. PEM SPKI is the form `install.sh` writes; a raw
// 32-byte key in hex or base64 is accepted too because that is the shape the
// repository's own signing tooling (ops/sign-manifest.py) already deals in,
// and an operator who pastes one should not get an unexplainable verification
// failure instead of a readable one.
//
// FROZEN: the 12-byte prefix below is the constant SPKI header for an Ed25519
// public key (RFC 8410 §4). It is a wire format, not a magic number to be
// tidied.
function loadReleasePublicKey(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
  if (!text) return null;
  if (text.includes("-----BEGIN")) {
    try {
      return crypto.createPublicKey(text);
    } catch {
      return null;
    }
  }
  const bytes = decodeRawKeyBytes(text);
  if (!bytes) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}

function decodeSignature(value) {
  if (typeof value !== "string" || !value) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === RELEASE_SIGNATURE_BYTES ? bytes : null;
}

// ---------------------------------------------------------------------------
// Default seams.

const defaultSleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

// The node's own /healthz, which answers before authorize() and therefore
// needs no credential. It is the single introspection surface used both for
// the drain check and for the post-restart verification, deliberately: the
// counters it reports come from jobs.mjs (activeChildren) and terminals.mjs
// (the live session list) — see server.mjs's healthPayload — and reading them
// over loopback is the only way `relayd update --file`, which runs in a
// DIFFERENT process from the daemon, can see them at all.
function ownHealthUrl() {
  const probeHost = isWildcardHost(host) ? "127.0.0.1" : host;
  return `${servesTls ? "https" : "http"}://${bracketHost(probeHost)}:${port}/healthz`;
}

function probeOwnHealth({ timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let request;
    try {
      const url = new URL(ownHealthUrl());
      const transport = url.protocol === "https:" ? https : http;
      request = transport.get(
        url,
        {
          timeout: timeoutMs,
          // A fresh socket per probe: a pooled connection to the daemon that
          // is being restarted must never be handed to the probe checking
          // whether its replacement came up (the same rule test/helpers/
          // wait.mjs documents at length).
          agent: false,
          // The node signs its own leaf and the CA pin is the phone's
          // business, not this loopback probe's. The only question here is
          // which version the process on this port reports.
          rejectUnauthorized: false,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            let parsed = null;
            try {
              parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              parsed = null;
            }
            if (response.statusCode !== 200 || !parsed || typeof parsed !== "object") return done({ ok: false });
            done({
              ok: true,
              version: typeof parsed.version === "string" ? parsed.version : null,
              activeJobs: Number.isInteger(parsed.activeJobs) ? parsed.activeJobs : null,
              activeTerminals: Number.isInteger(parsed.activeTerminals) ? parsed.activeTerminals : null,
            });
          });
          response.on("error", () => done({ ok: false }));
        },
      );
    } catch {
      return done({ ok: false });
    }
    request.on("error", () => done({ ok: false }));
    request.on("timeout", () => {
      request.destroy();
      done({ ok: false });
    });
  });
}

// node has no tar in its standard library, so this is the one unavoidable
// shell-out on the happy path — behind a seam precisely so a test never needs
// a real tarball.
async function defaultExtract(tarFile, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  await execFileAsync("tar", ["-xzf", tarFile, "-C", destDir], { timeout: 120_000 });
}

function underSystemd() {
  if (process.env.INVOCATION_ID) return true;
  try {
    return fs.existsSync("/run/systemd/system");
  } catch {
    return false;
  }
}

// THE DOCUMENTED FALLBACK, and it is deliberately not "restart ourselves
// anyway". systemd is the only supervisor dist/install.sh installs; without
// one there is nothing to bring relayd back, so exiting would turn an update
// into an outage and break the rule the rest of this file is built on — a
// broken update path must never take a healthy node or its running jobs
// offline. So an unsupervised node flips `current`, says so, and leaves the
// restart to the operator: the next start picks up the new release, and
// resumePendingApply() completes or reverses the apply when it does.
async function defaultRestart(serviceName) {
  if (!underSystemd()) return { restarted: false, mode: "unsupervised" };
  await execFileAsync("systemctl", ["restart", serviceName], { timeout: 120_000 });
  return { restarted: true, mode: "systemd" };
}

// ---------------------------------------------------------------------------

function readJsonFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
}

function isRelaydTree(dir) {
  try {
    return (
      fs.existsSync(path.join(dir, "package.json")) &&
      fs.existsSync(path.join(dir, "src", "index.mjs")) &&
      fs.existsSync(path.join(dir, "bin", "relayd"))
    );
  } catch {
    return false;
  }
}

// A tarball may or may not carry a top-level prefix directory, and which one
// it is depends on how it was rolled. Accepting both — rather than pinning
// --strip-components and getting it wrong once — is what keeps a correctly
// signed artifact from being rejected for a packaging detail.
function findAppRoot(dir) {
  if (isRelaydTree(dir)) return dir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dir, entry.name);
    if (isRelaydTree(candidate)) return candidate;
  }
  return null;
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover staging directory costs disk, not correctness.
  }
}

function rmFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Same.
  }
}

function createUpdateEngine({
  // Identity of the build this process is running. Injected so a test can
  // pretend to be any version without packaging one.
  runningVersion = runningBuildVersion,
  channel = releaseChannel,
  autoApply = autoUpdate,

  // Layout.
  updateRoot = configuredUpdateRoot,
  stateDir = configuredStateDir,
  publicKeyFile = configuredPublicKeyFile,
  serviceName = updateServiceName,

  // Seams.
  fetchImpl = fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
  extract = defaultExtract,
  restart = defaultRestart,
  probeHealth = probeOwnHealth,
  readActiveWork = null,
  audit = appendAudit,
  // Optional: a successful apply tells the phone what happened. Fire and
  // forget, exactly like every other postEvent caller. Usually supplied later
  // via setPostEvent, because the cloud client that owns it is built after
  // this engine (the engine is what tells that client what is staged).
  postEvent = null,

  // Bounds.
  maxArtifactBytes = MAX_ARTIFACT_BYTES,
  drainWaitMs = updateDrainWaitSec * 1000,
  drainPollMs = 2000,
  healthWaitMs = updateHealthWaitSec * 1000,
  healthPollMs = 1000,
} = {}) {
  const releasesDir = path.join(updateRoot, "releases");
  const currentLink = path.join(updateRoot, "current");
  const downloadDir = path.join(stateDir, "downloads");

  // Mutable node state, under CODEX_DATA_DIR rather than beside the code: a
  // `releases/<version>` directory is meant to be immutable once staged.
  const stagedPath = path.join(stateDir, "staged.json");
  const pinPath = path.join(stateDir, "pin.json");
  const poisonPath = path.join(stateDir, "poisoned.json");
  const applyingPath = path.join(stateDir, "applying.json");
  const announcedPath = path.join(stateDir, "announced.json");

  // The poll re-states the same announcement every cycle (it is state, not a
  // message), so without this an unchanged release would write an audit line
  // and a state file every handoffPollMaxWaitSec, forever.
  let lastAnnouncementKey = null;

  // Same shape as jobs.mjs's setJobNotificationHook, and for the same reason:
  // the push path is built after the thing that wants to use it. An apply
  // resumed at BOOT (resumePendingApply) therefore reports through the audit
  // log only — the cloud client does not exist yet at that point.
  let eventSink = typeof postEvent === "function" ? postEvent : null;

  function setPostEvent(hook) {
    eventSink = typeof hook === "function" ? hook : null;
  }

  // One apply at a time. An apply spans a download, a drain window measured in
  // minutes and a restart; the poll that triggered it fires again long before
  // that finishes.
  let applyInFlight = false;

  function ensureStateDir() {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  function writeState(file, value) {
    if (!ensureStateDir()) return false;
    try {
      writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  function clearState(file) {
    rmFile(file);
  }

  // --- pin ------------------------------------------------------------------

  function pinnedVersion() {
    const record = readJsonFile(pinPath);
    return record ? cleanVersion(record.version) : null;
  }

  function pin(value) {
    const version = cleanVersion(value);
    if (!version) return { ok: false, reason: "version_invalid" };
    writeState(pinPath, { version, pinnedAt: new Date(now()).toISOString() });
    audit("update_pinned", null, { version });
    return { ok: true, version };
  }

  function unpin() {
    const previous = pinnedVersion();
    clearState(pinPath);
    audit("update_unpinned", null, { version: previous });
    return { ok: true, version: previous };
  }

  // --- poison ---------------------------------------------------------------

  function poisonedEntries() {
    const record = readJsonFile(poisonPath);
    return Array.isArray(record?.entries) ? record.entries : [];
  }

  // Keyed on BOTH the digest and the version. The digest is the precise
  // statement ("these exact bytes failed verification"), and it is what stops
  // a re-announcement of the same artifact from being retried in a loop. The
  // version is the coarser one, and it is what a rollback records: a build
  // that failed its own health check must not be re-applied even if it is
  // re-published at a different digest.
  function isPoisoned({ version = null, sha256 = null } = {}) {
    for (const entry of poisonedEntries()) {
      if (!entry || typeof entry !== "object") continue;
      if (sha256 && entry.sha256 === sha256) return entry;
      if (version && entry.version === version && !entry.sha256) return entry;
    }
    return null;
  }

  function poison({ version = null, sha256 = null, reason = "unknown" }) {
    const entries = poisonedEntries().filter(
      (entry) => entry && typeof entry === "object" && !(entry.sha256 === sha256 && entry.version === version),
    );
    entries.push({ version, sha256, reason, at: new Date(now()).toISOString() });
    writeState(poisonPath, { entries: entries.slice(-MAX_POISON_ENTRIES) });
    audit("update_poisoned", null, { version, sha256, reason });
  }

  // --- staged ---------------------------------------------------------------

  // What the heartbeat reports as `pendingVersion`. Read from disk on every
  // call rather than cached, because it is written by an apply that may be
  // running in another process (`relayd update --file`) and read by a
  // long-lived daemon — and because the whole point of persisting it is that
  // it survives a restart, which an in-memory value would not.
  function pendingVersion() {
    const record = readJsonFile(stagedPath);
    if (!record) return null;
    const version = cleanVersion(record.version);
    if (!version) return null;
    // A staged record whose directory has been removed is stale, and
    // reporting it would make a node look stuck mid-update forever.
    return typeof record.dir === "string" && isRelaydTree(record.dir) ? version : null;
  }

  function stagedRecord() {
    const record = readJsonFile(stagedPath);
    if (!record) return null;
    const version = cleanVersion(record.version);
    if (!version || typeof record.dir !== "string" || !isRelaydTree(record.dir)) return null;
    return { version, dir: record.dir, sha256: typeof record.sha256 === "string" ? record.sha256 : null };
  }

  function announcedRelease() {
    return readJsonFile(announcedPath);
  }

  // --- decide ---------------------------------------------------------------

  // Step 1 of the spec's apply algorithm, and the only step with no side
  // effects: given an announcement, may this node move to it? Pure so it can
  // answer `relayd update --check` without touching anything.
  function decide(release) {
    if (!release || typeof release !== "object") return { ok: false, reason: "release_malformed" };
    const announced = cleanVersion(release.version);
    if (!announced) return { ok: false, reason: "version_invalid" };
    if (release.channel !== channel) {
      return { ok: false, reason: "channel_mismatch", detail: { announced: release.channel, subscribed: channel } };
    }

    const pinnedTo = pinnedVersion();
    if (pinnedTo && pinnedTo !== announced) {
      return { ok: false, reason: "pinned", detail: { pinnedTo } };
    }

    const order = compareVersions(announced, runningVersion);
    if (order === null) {
      // Either side unparseable. Refusing is the conservative answer and it is
      // also the honest one: this engine cannot say which of two versions it
      // cannot order is newer, and guessing in the permissive direction is how
      // a downgrade gets installed.
      return { ok: false, reason: "version_unorderable", detail: { announced, running: runningVersion } };
    }
    if (order === 0) return { ok: false, reason: "already_running", detail: { running: runningVersion } };
    if (order < 0) {
      // Not merely "pointless": announcing an old version forever is how a
      // fleet gets walked back to a build with a known hole.
      return { ok: false, reason: "downgrade_refused", detail: { announced, running: runningVersion } };
    }

    if (release.minVersion !== null && release.minVersion !== undefined) {
      const minimum = cleanVersion(release.minVersion);
      if (!minimum) return { ok: false, reason: "min_version_invalid", detail: { minVersion: release.minVersion } };
      const reach = compareVersions(runningVersion, minimum);
      if (reach === null) {
        return { ok: false, reason: "version_unorderable", detail: { minVersion: minimum, running: runningVersion } };
      }
      if (reach < 0) {
        // The escape hatch for a migration that cannot be skipped. The audit
        // line names the intermediate so the operator is not left guessing
        // which release to install first.
        return {
          ok: false,
          reason: "min_version_not_met",
          detail: { running: runningVersion, requires: minimum, target: announced },
        };
      }
    }

    const poisonedBy = isPoisoned({ version: announced, sha256: release.sha256 ?? null });
    if (poisonedBy) {
      return { ok: false, reason: "poisoned", detail: { poisonedBy: poisonedBy.reason ?? null } };
    }

    return { ok: true, version: announced };
  }

  // --- download + verify ----------------------------------------------------

  async function downloadAndVerify(release) {
    if (!ensureStateDir()) return { ok: false, reason: "state_dir_unwritable" };
    try {
      fs.mkdirSync(downloadDir, { recursive: true });
    } catch {
      return { ok: false, reason: "state_dir_unwritable" };
    }

    let bytes;
    try {
      const response = await fetchImpl(release.url);
      if (response.status !== 200) {
        audit("update_download_failed", null, { version: release.version, status: response.status });
        return { ok: false, reason: `download_status_${response.status}` };
      }
      const declared = Number(response.headers?.get?.("content-length") ?? NaN);
      if (Number.isFinite(declared) && declared > maxArtifactBytes) {
        audit("update_download_failed", null, { version: release.version, reason: "artifact_too_large", bytes: declared });
        return { ok: false, reason: "artifact_too_large" };
      }
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      audit("update_download_failed", null, { version: release.version, error: error?.message || String(error) });
      return { ok: false, reason: "download_failed" };
    }

    if (bytes.length > maxArtifactBytes) {
      audit("update_download_failed", null, { version: release.version, reason: "artifact_too_large", bytes: bytes.length });
      return { ok: false, reason: "artifact_too_large" };
    }

    const digest = crypto.createHash("sha256").update(bytes).digest();
    const digestHex = digest.toString("hex");
    const file = path.join(downloadDir, `relayd-${release.version}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tar.gz`);
    try {
      fs.writeFileSync(file, bytes, { mode: 0o600 });
    } catch {
      return { ok: false, reason: "download_unwritable" };
    }

    const verified = verifyArtifact({ digest, digestHex, expectedSha256: release.sha256, sig: release.sig, version: release.version });
    if (!verified.ok) {
      // Never a partial install: the bytes go away before anything else can
      // look at them.
      rmFile(file);
      return verified;
    }
    return { ok: true, file, digestHex };
  }

  // Digest first, then signature over the digest bytes. The order matters for
  // the error message, not for security: the signature covers the digest
  // rather than the URL precisely so an artifact can be re-hosted or moved
  // behind a CDN without re-signing, which means a digest that does not match
  // is a different artifact and there is nothing left to verify.
  function verifyArtifact({ digest, digestHex, expectedSha256, sig, version }) {
    // Poisoning is keyed on the ANNOUNCED digest, not on the digest of the
    // bytes that actually arrived. That distinction only matters for a digest
    // mismatch, and it is the whole point there: decide() sees the
    // announcement, so an entry recorded under the bytes' digest would never
    // be consulted and the same broken announcement would be re-downloaded on
    // every poll. For a local artifact there is no announcement, so the bytes
    // are the only identity available.
    const announced = typeof expectedSha256 === "string" && expectedSha256 ? expectedSha256.toLowerCase() : null;
    const poisonKey = announced ?? digestHex;
    if (announced) {
      const expected = Buffer.from(announced, "hex");
      if (expected.length !== digest.length || !crypto.timingSafeEqual(expected, digest)) {
        audit("update_verify_failed", null, { version, reason: "digest_mismatch", expected: announced, actual: digestHex });
        poison({ version, sha256: poisonKey, reason: "digest_mismatch" });
        return { ok: false, reason: "digest_mismatch" };
      }
    }

    const publicKey = loadReleasePublicKey(publicKeyFile);
    if (!publicKey) {
      // Deliberately NOT poisoned. A missing or unreadable public key is a
      // fault in this node's installation, not in the artifact; poisoning
      // would make the node refuse that release forever, including after the
      // key is repaired.
      audit("update_verify_failed", null, { version, reason: "no_public_key", keyFile: publicKeyFile });
      return { ok: false, reason: "no_public_key" };
    }

    const signature = decodeSignature(sig);
    if (!signature) {
      audit("update_verify_failed", null, { version, reason: "signature_malformed" });
      poison({ version, sha256: poisonKey, reason: "signature_malformed" });
      return { ok: false, reason: "signature_malformed" };
    }

    let valid = false;
    try {
      valid = crypto.verify(null, digest, publicKey, signature);
    } catch {
      valid = false;
    }
    if (!valid) {
      audit("update_verify_failed", null, { version, reason: "signature_invalid", sha256: digestHex });
      poison({ version, sha256: poisonKey, reason: "signature_invalid" });
      return { ok: false, reason: "signature_invalid" };
    }

    audit("update_verified", null, { version, sha256: digestHex });
    return { ok: true };
  }

  // --- stage ----------------------------------------------------------------

  // Step 3: unpack beside the running copy, never over it. That is the
  // prerequisite the old in-place `install.sh` upgrade could not satisfy —
  // it copied over the live directory, so there was nothing to roll back to.
  //
  // `expectVersion` is the announced version when there is an announcement and
  // null for a local artifact, where the tree itself is the only statement of
  // what this build is.
  async function stage(file, { expectVersion = null, sha256 = null } = {}) {
    try {
      fs.mkdirSync(releasesDir, { recursive: true });
    } catch (error) {
      audit("update_stage_failed", null, { version: expectVersion, reason: "releases_dir_unwritable", error: error?.code || null });
      return { ok: false, reason: "releases_dir_unwritable" };
    }

    const staging = path.join(releasesDir, `.staging-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
    try {
      await extract(file, staging);
    } catch (error) {
      rmDir(staging);
      audit("update_stage_failed", null, { version: expectVersion, reason: "extract_failed", error: error?.message || String(error) });
      return { ok: false, reason: "extract_failed" };
    }

    const appRoot = findAppRoot(staging);
    if (!appRoot) {
      rmDir(staging);
      audit("update_stage_failed", null, { version: expectVersion, reason: "artifact_not_relayd" });
      if (expectVersion) poison({ version: expectVersion, sha256, reason: "artifact_not_relayd" });
      return { ok: false, reason: "artifact_not_relayd" };
    }

    const identity = readBuildIdentity({ appDir: appRoot });
    // A signed artifact that does not contain the version it was announced as
    // is a mismatch between the announcement and the bytes. The signature
    // covers the digest, not the version, so this is the check that makes
    // "0.3.0 is published" and "these bytes are 0.3.0" the same statement.
    if (expectVersion && identity.version !== expectVersion) {
      rmDir(staging);
      audit("update_stage_failed", null, {
        version: expectVersion,
        reason: "artifact_version_mismatch",
        artifactVersion: identity.version,
      });
      poison({ version: expectVersion, sha256, reason: "artifact_version_mismatch" });
      return { ok: false, reason: "artifact_version_mismatch", detail: { artifactVersion: identity.version } };
    }

    const version = expectVersion || identity.version;
    const target = path.join(releasesDir, version);
    try {
      // Re-staging the same version is allowed: an interrupted earlier attempt
      // may have left a partial tree, and the digest has already been verified
      // by the time we get here.
      rmDir(target);
      fs.renameSync(appRoot, target);
    } catch (error) {
      rmDir(staging);
      audit("update_stage_failed", null, { version, reason: "stage_move_failed", error: error?.code || null });
      return { ok: false, reason: "stage_move_failed" };
    }
    rmDir(staging);

    const record = { version, dir: target, sha256, stagedAt: new Date(now()).toISOString() };
    if (!writeState(stagedPath, record)) {
      audit("update_stage_failed", null, { version, reason: "staged_state_unwritable" });
      return { ok: false, reason: "staged_state_unwritable" };
    }
    audit("update_staged", null, { version, dir: target, sha256, commit: identity.commit });
    return { ok: true, staged: record };
  }

  // --- drain ----------------------------------------------------------------

  const activeWork = readActiveWork || (async () => {
    const health = await probeHealth();
    if (!health?.ok) return { ok: false, jobs: null, terminals: null };
    return {
      ok: true,
      jobs: Number.isInteger(health.activeJobs) ? health.activeJobs : 0,
      // A node still running a build from before this spec reports no
      // terminal count at all; 0 is the only available answer and it is
      // recorded rather than inferred silently.
      terminals: Number.isInteger(health.activeTerminals) ? health.activeTerminals : 0,
    };
  });

  // Step 4: do not restart while work is live. relayd holds job runs, SSE
  // streams and terminal sessions, so a restart is visible on the phone
  // mid-sentence.
  //
  // An unreachable /healthz counts as idle, not as busy, and that is a
  // deliberate choice in the other direction from the rest of this file: a
  // node whose own health endpoint does not answer is already not serving the
  // phone, so there is no live work to protect — whereas treating it as busy
  // would mean a staged release can never land on a node with a
  // misconfigured listener, which is the worse failure because it is silent.
  // It gets its own audit line so the decision is visible after the fact.
  async function drain({ force = false } = {}) {
    if (force) {
      audit("update_drain_skipped", null, { reason: "forced" });
      return { ok: true, forced: true };
    }
    const deadline = now() + drainWaitMs;
    let waited = false;
    for (;;) {
      const work = await activeWork();
      if (!work?.ok) {
        audit("update_drain_blind", null, { note: "node health unreachable; treating as idle" });
        return { ok: true, blind: true };
      }
      if (work.jobs === 0 && work.terminals === 0) {
        if (waited) audit("update_drained", null, { waitedMs: drainWaitMs - Math.max(0, deadline - now()) });
        return { ok: true, work };
      }
      if (now() >= deadline) {
        audit("update_drain_expired", null, { jobs: work.jobs, terminals: work.terminals, windowMs: drainWaitMs });
        return { ok: false, reason: "drain_window_expired", work };
      }
      if (!waited) {
        waited = true;
        audit("update_drain_waiting", null, { jobs: work.jobs, terminals: work.terminals, windowMs: drainWaitMs });
      }
      await sleep(drainPollMs);
    }
  }

  // --- flip -----------------------------------------------------------------

  // The symlink target is stored RELATIVE to updateRoot when it points inside
  // it, so the whole /opt/relayd tree stays relocatable and a `current` read
  // back later is comparable to what was written.
  function linkTargetFor(dir) {
    const relative = path.relative(updateRoot, dir);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : dir;
  }

  function readCurrentLink() {
    try {
      return fs.readlinkSync(currentLink);
    } catch {
      return null;
    }
  }

  // Atomic for a reader: a temp symlink with a unique name, renamed into
  // place. rename(2) over an existing symlink replaces it in one step, so
  // nothing ever observes a `current` that does not exist.
  function flip(dir) {
    let existing;
    try {
      existing = fs.lstatSync(currentLink);
    } catch {
      existing = null;
    }
    if (existing && !existing.isSymbolicLink()) {
      // A real directory at `current` means this node was installed by
      // something that does not use this layout. Replacing it would delete
      // the running copy with no way back, which is the opposite of the point.
      audit("update_flip_failed", null, { reason: "current_not_a_symlink", path: currentLink });
      return { ok: false, reason: "current_not_a_symlink" };
    }
    const temp = `${currentLink}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
    try {
      fs.symlinkSync(linkTargetFor(dir), temp);
      fs.renameSync(temp, currentLink);
    } catch (error) {
      rmFile(temp);
      audit("update_flip_failed", null, { reason: "symlink_failed", error: error?.code || null });
      return { ok: false, reason: "flip_failed" };
    }
    // The link this replaced is deliberately NOT returned: applyStaged reads
    // it before writing the applying record, so there is exactly one recorded
    // answer to "where does rollback point back to" and it is the one that was
    // persisted.
    return { ok: true };
  }

  // --- apply ----------------------------------------------------------------

  // Steps 5-7. Under real systemd the restart at step 5 terminates THIS
  // process, so steps 6 and 7 usually do not run here at all — they are
  // completed by resumePendingApply() when the node next boots, which is why
  // the intent is written to disk first. The in-process path below is what
  // runs when the restart seam does not kill us: the unsupervised fallback,
  // and every test.
  //
  // KNOWN LIMITATION, stated rather than hidden: if a flipped release is so
  // broken that it cannot boot at all, nothing in it runs to roll it back, and
  // systemd's Restart=on-failure will crash-loop it. Covering that needs a
  // watchdog outside the flipped tree; the escape hatch today is the operator's
  // shell and `relayd update --file <previous-artifact>`, which is exactly the
  // credential the spec says the update path must never be weaker than.
  async function applyStaged(staged, { force = false } = {}) {
    const drained = await drain({ force });
    if (!drained.ok) {
      // Stays staged on purpose: the announcement is state, so the next poll
      // re-states it and this runs again once the node is idle.
      return { ok: false, reason: drained.reason, staged: staged.version };
    }

    // The intent is written BEFORE the flip, not after. Between those two
    // steps the process can die — systemd's restart, a power cut, an OOM kill
    // — and a node that has a flipped `current` but no record of why cannot
    // tell, on its next boot, whether it is running a confirmed release or an
    // unverified one. Writing first makes that window fall on the safe side:
    // a record with no flip is reconciled as "still on `from`", which
    // resumePendingApply resolves by pointing `current` back where it already
    // is.
    const deadline = now() + healthWaitMs;
    const previous = readCurrentLink();
    writeState(applyingPath, {
      from: runningVersion,
      to: staged.version,
      previous,
      target: linkTargetFor(staged.dir),
      deadline,
      at: new Date(now()).toISOString(),
    });

    const flipped = flip(staged.dir);
    if (!flipped.ok) {
      clearState(applyingPath);
      return { ok: false, reason: flipped.reason, staged: staged.version };
    }
    audit("update_flipped", null, { from: runningVersion, to: staged.version, previous });

    let restarted;
    try {
      restarted = await restart(serviceName);
    } catch (error) {
      audit("update_restart_failed", null, { to: staged.version, error: error?.message || String(error) });
      return rollback({ to: staged.version, previous, reason: "restart_failed" });
    }

    if (!restarted?.restarted) {
      audit("update_restart_deferred", null, { to: staged.version, mode: restarted?.mode || "unsupervised" });
      return { ok: true, restarted: false, version: staged.version, mode: restarted?.mode || "unsupervised" };
    }

    const healthy = await awaitHealthyVersion(staged.version, deadline);
    if (!healthy.ok) {
      audit("update_health_failed", null, { to: staged.version, reported: healthy.reported, windowMs: healthWaitMs });
      return rollback({ to: staged.version, previous, reason: "health_check_failed" });
    }

    return succeed({ to: staged.version, from: runningVersion });
  }

  // Step 6. Bounded, and it checks the reported VERSION rather than merely
  // that something answered: the old build answering /healthz on the same port
  // is exactly the failure this is looking for.
  async function awaitHealthyVersion(target, deadline) {
    let reported = null;
    for (;;) {
      const health = await probeHealth();
      if (health?.ok) {
        reported = health.version ?? null;
        if (reported === target) return { ok: true, reported };
      }
      if (now() >= deadline) return { ok: false, reported };
      await sleep(healthPollMs);
    }
  }

  function succeed({ to, from }) {
    clearState(applyingPath);
    clearState(stagedPath);
    audit("update_applied", null, { from, to });
    if (eventSink) {
      try {
        // Best effort, and it may be rejected by a control plane that has not
        // learned this event type yet: postEvent is fire-and-forget and
        // already treats a 4xx as "not accepted" rather than as an error.
        void Promise.resolve(eventSink("node.updated")).catch(() => null);
      } catch {
        /* an apply is not failed by a push that could not be queued */
      }
    }
    return { ok: true, restarted: true, version: to };
  }

  // Step 7. Point `current` back, restart, audit, and poison the version so
  // the next poll — which will re-state the same announcement — does not walk
  // straight back into the same failure.
  async function rollback({ to, previous, reason }) {
    let restored = false;
    if (previous) {
      const temp = `${currentLink}.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
      try {
        fs.symlinkSync(previous, temp);
        fs.renameSync(temp, currentLink);
        restored = true;
      } catch {
        rmFile(temp);
      }
    }
    let restartedBack = false;
    if (restored) {
      try {
        const result = await restart(serviceName);
        restartedBack = Boolean(result?.restarted);
      } catch {
        // Audited below; there is nothing further this process can do, and
        // throwing here would replace a reported rollback with a crash.
      }
    }
    clearState(applyingPath);
    clearState(stagedPath);
    poison({ version: to, reason });
    audit("update_rolled_back", null, { to, previous, reason, restored, restarted: restartedBack });
    return { ok: false, reason, rolledBack: restored, version: to };
  }

  // Called once at startup. Under systemd the restart in applyStaged kills the
  // process mid-apply, so this is where an apply is normally completed: the new
  // build confirms itself, or — if what came up is not the version that was
  // flipped to — reverses the flip.
  async function resumePendingApply() {
    const applying = readJsonFile(applyingPath);
    if (!applying) return { ok: true, skipped: "nothing_pending" };
    const to = cleanVersion(applying.to);
    if (!to) {
      clearState(applyingPath);
      return { ok: true, skipped: "applying_record_invalid" };
    }
    if (runningVersion === to) return succeed({ to, from: cleanVersion(applying.from) });
    audit("update_health_failed", null, { to, reported: runningVersion, note: "resumed after restart" });
    return rollback({
      to,
      previous: typeof applying.previous === "string" ? applying.previous : null,
      reason: "health_check_failed",
    });
  }

  // --- entry points ---------------------------------------------------------

  // What `onRelease` is wired to. Never throws: the poll loop dispatches this
  // best-effort and a broken update path must not take down handoff pickup.
  //
  // It also never BLOCKS, which matters just as much and is less obvious. The
  // poll awaits this handler, the handoff loop awaits the poll, and an apply
  // spans a drain window measured in minutes (RELAYD_UPDATE_DRAIN_WAIT_SEC
  // defaults to 900) plus a restart. Awaiting the apply here would stall
  // handoff pickup and credential sync for the whole drain window — the
  // update path taking a healthy node's other work down with it, which is the
  // exact failure mode the rest of this file is built to avoid. So the
  // decision is returned immediately and the apply runs detached, guarded by
  // applyInFlight so the next poll does not start a second one. The promise
  // is handed back rather than dropped, so a caller that wants to wait (a
  // test, or a future CLI path) can.
  async function handleRelease(release) {
    const decision = decide(release);
    const key = `${release?.version ?? ""}|${release?.sha256 ?? ""}|${decision.ok ? "apply" : decision.reason}`;
    if (key !== lastAnnouncementKey) {
      lastAnnouncementKey = key;
      // Recorded for `relayd update --check`, which runs in a separate
      // short-lived process and must NOT poll the cloud itself: pollHandoffs
      // acks the handoffs it receives, so a CLI poll would confirm delivery of
      // work the daemon never imports.
      writeState(announcedPath, {
        release,
        seenAt: new Date(now()).toISOString(),
        runningVersion,
        decision: decision.ok ? "apply" : decision.reason,
        detail: decision.detail ?? null,
      });
      audit("update_release_seen", null, {
        channel: release?.channel ?? null,
        version: release?.version ?? null,
        notes: release?.notes ?? null,
        decision: decision.ok ? "apply" : decision.reason,
        ...(decision.detail ?? {}),
      });
    }
    if (!decision.ok) return decision;
    if (!autoApply) return { ok: false, reason: "auto_update_disabled", version: decision.version };
    if (applyInFlight) return { ok: false, reason: "apply_in_flight" };
    const applied = applyRelease(release).catch((error) => {
      // applyRelease is written not to throw, so this is the guard against a
      // defect in it rather than an expected path — but an unhandled rejection
      // from a detached promise would take the whole process down, which is
      // the one outcome an update must never cause.
      audit("update_apply_crashed", null, { version: decision.version, error: error?.message || String(error) });
      return { ok: false, reason: "apply_crashed" };
    });
    return { ok: true, started: true, version: decision.version, applied };
  }

  async function applyRelease(release, { force = false } = {}) {
    const decision = decide(release);
    if (!decision.ok) {
      audit("update_refused", null, { version: release?.version ?? null, reason: decision.reason, ...(decision.detail ?? {}) });
      return decision;
    }
    if (applyInFlight) return { ok: false, reason: "apply_in_flight" };
    applyInFlight = true;
    try {
      // An already-staged release is not re-downloaded. This is the path taken
      // after a drain window expired: the artifact is on disk and verified, and
      // only the restart is still owed.
      let staged = stagedRecord();
      if (!staged || staged.version !== decision.version) {
        const downloaded = await downloadAndVerify(release);
        if (!downloaded.ok) return downloaded;
        const result = await stage(downloaded.file, { expectVersion: decision.version, sha256: downloaded.digestHex });
        rmFile(downloaded.file);
        if (!result.ok) return result;
        staged = result.staged;
      }
      return await applyStaged(staged, { force });
    } finally {
      applyInFlight = false;
    }
  }

  // `relayd update --file <tarball>`: the same verify/stage/drain/flip/verify/
  // rollback path with no cloud involved at all.
  //
  // The SIGNATURE is still mandatory — a local artifact is not more trusted
  // than an announced one, and the offline signing key is the whole trust
  // story. The digest check is skipped because there is nothing independent to
  // compare against: the digest is computed from the file in front of us, so
  // the signature over it is the only statement that means anything.
  //
  // The announcement-time refusals are NOT applied here. A downgrade refusal
  // exists to stop a compromised control plane from walking a fleet backwards;
  // an operator with a shell on the machine installing an older build on
  // purpose is the recovery path, and refusing it would remove the escape
  // hatch from the crash-loop limitation documented above. Loudly audited
  // instead.
  async function applyLocalFile(file, { force = false, sig = null } = {}) {
    if (applyInFlight) return { ok: false, reason: "apply_in_flight" };
    let bytes;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return { ok: false, reason: "artifact_unreadable" };
    }
    if (bytes.length > maxArtifactBytes) return { ok: false, reason: "artifact_too_large" };

    const signature = sig ?? readSidecarSignature(file);
    if (!signature) {
      audit("update_verify_failed", null, { reason: "no_signature", file });
      return { ok: false, reason: "no_signature" };
    }

    const digest = crypto.createHash("sha256").update(bytes).digest();
    const digestHex = digest.toString("hex");
    applyInFlight = true;
    try {
      const verified = verifyArtifact({ digest, digestHex, expectedSha256: null, sig: signature, version: null });
      if (!verified.ok) return verified;

      const result = await stage(file, { expectVersion: null, sha256: digestHex });
      if (!result.ok) return result;

      const order = compareVersions(result.staged.version, runningVersion);
      if (order !== null && order <= 0) {
        audit("update_local_override", null, {
          version: result.staged.version,
          running: runningVersion,
          note: order === 0 ? "re-applying the running version" : "installing an older version",
        });
      }
      return await applyStaged(result.staged, { force });
    } finally {
      applyInFlight = false;
    }
  }

  // `<tarball>.sig`, base64/base64url, as produced by the signing step. A
  // sidecar rather than a flag so the signature travels with the artifact when
  // an operator copies one onto a machine.
  function readSidecarSignature(file) {
    try {
      const text = fs.readFileSync(`${file}.sig`, "utf8").trim();
      return text || null;
    } catch {
      return null;
    }
  }

  // What `relayd update --check` prints. Changes nothing.
  function status() {
    const announced = announcedRelease();
    return {
      runningVersion,
      channel,
      autoApply,
      pinnedVersion: pinnedVersion(),
      pendingVersion: pendingVersion(),
      updateRoot,
      currentLink: readCurrentLink(),
      publicKeyPresent: Boolean(loadReleasePublicKey(publicKeyFile)),
      publicKeyFile,
      announced: announced?.release ?? null,
      announcedSeenAt: announced?.seenAt ?? null,
      announcedDecision: announced?.decision ?? null,
      poisoned: poisonedEntries(),
    };
  }

  return {
    decide,
    handleRelease,
    applyRelease,
    applyLocalFile,
    applyStaged,
    resumePendingApply,
    pendingVersion,
    pinnedVersion,
    pin,
    unpin,
    setPostEvent,
    poison,
    isPoisoned,
    status,
    paths: { stagedPath, pinPath, poisonPath, applyingPath, announcedPath, releasesDir, currentLink, downloadDir },
  };
}

export {
  createUpdateEngine,
  parseVersion,
  compareVersions,
  loadReleasePublicKey,
  MAX_ARTIFACT_BYTES,
};
