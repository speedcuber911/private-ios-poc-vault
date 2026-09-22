import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-update-data-"));

const { createUpdateEngine, compareVersions, loadReleasePublicKey } = await import("../src/update.mjs");

// ---------------------------------------------------------------------------
// The release signing key. In production the private half is OFFLINE and is
// not on the control-plane host; the tests hold both because they have to
// produce a valid artifact, and the point of every verification test below is
// that holding only the announcement is not enough.
const releaseKey = crypto.generateKeyPairSync("ed25519");
const releasePublicKeyPem = releaseKey.publicKey.export({ type: "spki", format: "pem" });

function signDigestOf(bytes, key = releaseKey.privateKey) {
  return crypto.sign(null, crypto.createHash("sha256").update(bytes).digest(), key).toString("base64url");
}

function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// A tree that looks like relayd to isRelaydTree/findAppRoot, which is all the
// engine inspects: package.json + src/index.mjs + bin/relayd, and the
// build-info.json that states what version those bytes are.
function writeRelaydTree(dir, version) {
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.mjs"), "// staged relayd\n");
  fs.writeFileSync(path.join(dir, "bin", "relayd"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(dir, "package.json"), `${JSON.stringify({ name: "relayd", version })}\n`);
  fs.writeFileSync(
    path.join(dir, "build-info.json"),
    `${JSON.stringify({ version, commit: "0".repeat(40), builtAt: "2026-09-21T00:00:00Z" })}\n`,
  );
}

// One node's worth of on-disk state: the /opt/relayd layout with the running
// version already staged and `current` pointing at it (which is what
// dist/install.sh now produces), plus the data dir the mutable state lives in.
//
// Every seam that touches a process, a service or the network is injected, so
// nothing here needs root, systemd, tar, or a real tarball.
function makeNode({
  runningVersion = "0.1.0",
  publicKey = releasePublicKeyPem,
  artifactVersion = null,
  extractFails = false,
  activeWork = null,
  healthVersion = undefined,
  channel = "stable",
  autoApply = true,
  drainWaitMs = 60_000,
  healthWaitMs = 0,
  restartResult = { restarted: true, mode: "systemd" },
  ...engineOptions
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-update-node-"));
  const updateRoot = path.join(root, "opt", "relayd");
  const stateDir = path.join(root, "var", "updates");
  const publicKeyFile = path.join(updateRoot, "release-pubkey.pem");
  fs.mkdirSync(path.join(updateRoot, "releases", runningVersion), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeRelaydTree(path.join(updateRoot, "releases", runningVersion), runningVersion);
  fs.symlinkSync(`releases/${runningVersion}`, path.join(updateRoot, "current"));
  if (publicKey !== null) fs.writeFileSync(publicKeyFile, publicKey);

  const audits = [];
  const restarts = [];
  // What each health probe answers. `healthVersion` undefined means "whatever
  // `current` now points at", which models a service that really did restart
  // into the flipped release; an explicit value models one that did not.
  const probes = [];
  const state = { extractVersion: artifactVersion };

  const engine = createUpdateEngine({
    runningVersion,
    channel,
    autoApply,
    updateRoot,
    stateDir,
    publicKeyFile,
    serviceName: "relayd-test.service",
    drainWaitMs,
    drainPollMs: 0,
    healthWaitMs,
    healthPollMs: 0,
    sleep: async () => {},
    audit: (event, _job, extra = {}) => audits.push({ event, ...extra }),
    extract: async (file, destDir) => {
      if (extractFails) throw new Error("simulated_tar_failure");
      fs.mkdirSync(destDir, { recursive: true });
      // Inside a prefix directory on purpose: a real tarball may or may not
      // carry one, and findAppRoot has to cope with both.
      const inner = path.join(destDir, "relayd-artifact");
      writeRelaydTree(inner, state.extractVersion ?? "0.2.0");
    },
    restart: async (name) => {
      restarts.push(name);
      if (restartResult instanceof Error) throw restartResult;
      return restartResult;
    },
    probeHealth: async () => {
      const reported = healthVersion === undefined ? currentVersion() : healthVersion;
      const answer = { ok: true, version: reported, activeJobs: 0, activeTerminals: 0 };
      probes.push(answer);
      return answer;
    },
    readActiveWork: activeWork,
    ...engineOptions,
  });

  function currentVersion() {
    try {
      return path.basename(fs.readlinkSync(path.join(updateRoot, "current")));
    } catch {
      return null;
    }
  }

  return {
    engine,
    root,
    updateRoot,
    stateDir,
    publicKeyFile,
    audits,
    restarts,
    probes,
    state,
    currentVersion,
    currentLink: () => {
      try {
        return fs.readlinkSync(path.join(updateRoot, "current"));
      } catch {
        return null;
      }
    },
    auditEvents: () => audits.map((entry) => entry.event),
    reasons: (event) => audits.filter((entry) => entry.event === event).map((entry) => entry.reason),
  };
}

// An announcement in exactly the shape cloudclient.mjs hands to the engine
// after validating the poll response's top-level `release` field.
function announcement(bytes, { version = "0.2.0", channel = "stable", minVersion = null, notes = null, sha256 = null, sig = null } = {}) {
  return {
    channel,
    version,
    url: "https://releases.example/relayd/relayd.tar.gz",
    sha256: sha256 ?? sha256Hex(bytes),
    sigAlg: "ed25519",
    sig: sig ?? signDigestOf(bytes),
    minVersion,
    notes,
  };
}

function servingArtifact(bytes) {
  return async () => ({
    status: 200,
    headers: { get: (name) => (name === "content-length" ? String(bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  });
}

// ---------------------------------------------------------------------------
// Version ordering. This is the machinery the downgrade refusal rests on, so
// "unparseable" reading as "equal" would be a security bug, not a rounding
// error: `null < 0` and `null > 0` are both false, so a coerced comparison
// silently treats an unorderable pair as the same version.
test("compareVersions orders releases, prereleases and numeric identifiers, and refuses to guess", () => {
  assert.equal(compareVersions("0.2.0", "0.1.0"), 1);
  assert.equal(compareVersions("0.1.0", "0.2.0"), -1);
  assert.equal(compareVersions("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareVersions("0.2.0", "0.2.0-rc.1"), 1, "a release outranks its own prerelease");
  assert.equal(compareVersions("0.2.0-rc.10", "0.2.0-rc.2"), 1, "rc identifiers compare numerically, not lexically");
  assert.equal(compareVersions("0.2.0+build9", "0.2.0"), 0, "build metadata is not part of the ordering");
  assert.equal(compareVersions("not-a-version", "0.1.0"), null);
  assert.equal(compareVersions("0.1.0", ""), null);
  assert.equal(compareVersions("0.1.0", null), null);
});

test("the release public key loads from PEM, raw hex and raw base64, and nothing else", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-update-key-"));
  const raw = releaseKey.publicKey.export({ type: "spki", format: "der" }).subarray(-32);

  const pem = path.join(dir, "pem");
  fs.writeFileSync(pem, releasePublicKeyPem);
  assert.ok(loadReleasePublicKey(pem));

  const hex = path.join(dir, "hex");
  fs.writeFileSync(hex, `${raw.toString("hex")}\n`);
  assert.ok(loadReleasePublicKey(hex));

  const b64 = path.join(dir, "b64");
  fs.writeFileSync(b64, `${raw.toString("base64url")}\n`);
  assert.ok(loadReleasePublicKey(b64));

  const junk = path.join(dir, "junk");
  fs.writeFileSync(junk, "not a key");
  assert.equal(loadReleasePublicKey(junk), null);
  assert.equal(loadReleasePublicKey(path.join(dir, "absent")), null, "a missing key file is null, not a throw");
});

// ---------------------------------------------------------------------------
// Step 1, "Decide". Each of these refusals is named in the spec as a
// consequence of putting an update channel on the path at all, not as
// optional hardening.

test("an announced version older than the running one is refused as a downgrade", async () => {
  const node = makeNode({ runningVersion: "0.3.0" });
  const bytes = Buffer.from("older-release");
  const result = await node.engine.handleRelease(announcement(bytes, { version: "0.2.0" }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "downgrade_refused");
  assert.equal(node.currentVersion(), "0.3.0", "current must not move");
  assert.equal(node.engine.pendingVersion(), null, "nothing may be staged for a refused announcement");
  assert.deepEqual(node.restarts, [], "a refusal must not restart the service");
  const seen = node.audits.find((entry) => entry.event === "update_release_seen");
  assert.equal(seen?.decision, "downgrade_refused", "the refusal is logged, with the reason");
});

test("a node below minVersion refuses and the audit line names the required intermediate", async () => {
  const node = makeNode({ runningVersion: "0.1.0" });
  const bytes = Buffer.from("needs-a-step");
  const result = await node.engine.handleRelease(announcement(bytes, { version: "0.4.0", minVersion: "0.2.0" }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "min_version_not_met");
  assert.equal(result.detail.requires, "0.2.0");
  assert.equal(node.engine.pendingVersion(), null);
  const seen = node.audits.find((entry) => entry.event === "update_release_seen");
  assert.equal(seen.decision, "min_version_not_met");
  assert.equal(seen.requires, "0.2.0", "the operator must not have to guess which release to install first");
  assert.equal(seen.target, "0.4.0");
});

test("a node at or above minVersion is allowed through it", () => {
  const node = makeNode({ runningVersion: "0.2.0" });
  const bytes = Buffer.from("reachable");
  assert.equal(node.engine.decide(announcement(bytes, { version: "0.4.0", minVersion: "0.2.0" })).ok, true);
  assert.equal(node.engine.decide(announcement(bytes, { version: "0.4.0", minVersion: "0.1.0" })).ok, true);
});

test("the running version, a foreign channel, and a pin are each refused on their own terms", () => {
  const node = makeNode({ runningVersion: "0.2.0", channel: "stable" });
  const bytes = Buffer.from("x");

  assert.equal(node.engine.decide(announcement(bytes, { version: "0.2.0" })).reason, "already_running");
  assert.equal(node.engine.decide(announcement(bytes, { version: "0.3.0", channel: "beta" })).reason, "channel_mismatch");
  // A string that passes the shape check but cannot be ORDERED is refused
  // rather than guessed at: `null < 0` is false, so a comparison that coerced
  // the answer would read as "already running" and silently do nothing.
  assert.equal(node.engine.decide(announcement(bytes, { version: "not-a-version" })).reason, "version_unorderable");
  assert.equal(node.engine.decide(announcement(bytes, { version: "../../etc/passwd" })).reason, "version_invalid");

  node.engine.pin("0.2.0");
  assert.equal(node.engine.decide(announcement(bytes, { version: "0.3.0" })).reason, "pinned");
  node.engine.unpin();
  assert.equal(node.engine.decide(announcement(bytes, { version: "0.3.0" })).ok, true);
});

// ---------------------------------------------------------------------------
// Step 2, "Download and verify". A failure here deletes the download, writes
// an audit line, and records the digest as poisoned so a re-announcement of
// the same artifact — and the poll re-states the announcement every cycle —
// is not retried in a loop.

test("a digest mismatch refuses, deletes the download, and poisons the digest", async () => {
  const bytes = Buffer.from("the-real-bytes");
  const node = makeNode({ fetchImpl: servingArtifact(bytes) });
  const release = announcement(bytes, { version: "0.2.0", sha256: "b".repeat(64) });

  const result = await node.engine.applyRelease(release);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "digest_mismatch");

  assert.ok(node.reasons("update_verify_failed").includes("digest_mismatch"));
  // Poisoned under the ANNOUNCED digest, not the digest of the bytes that
  // arrived. decide() only ever sees the announcement, so an entry recorded
  // under the bytes' digest would never be consulted and this same broken
  // announcement would be re-downloaded on every poll — which is the retry
  // loop the poisoning exists to close.
  assert.ok(node.engine.isPoisoned({ sha256: "b".repeat(64) }), "the announced digest must be recorded as poisoned");
  assert.equal(node.engine.pendingVersion(), null, "nothing may be staged");
  assert.deepEqual(fs.readdirSync(node.engine.paths.downloadDir), [], "the download must not survive a failed verification");
  assert.equal(node.currentVersion(), "0.1.0");

  // And the loop is closed: the same announcement again is refused before a
  // single byte is fetched.
  let fetches = 0;
  const again = makeNode({
    stateDir: node.stateDir,
    fetchImpl: async () => {
      fetches += 1;
      throw new Error("must not be reached");
    },
  });
  const repeat = await again.engine.applyRelease(announcement(bytes, { version: "0.2.0", sha256: "b".repeat(64) }));
  assert.equal(repeat.reason, "poisoned");
  assert.equal(fetches, 0, "a poisoned digest must never be downloaded again");
});

test("an invalid signature refuses, deletes the download, and poisons the digest", async () => {
  const bytes = Buffer.from("unsigned-bytes");
  const impostor = crypto.generateKeyPairSync("ed25519");
  const node = makeNode({ fetchImpl: servingArtifact(bytes) });

  // A perfectly valid signature — over the right digest, by the wrong key.
  // This is the whole trust story: the digest matches, the URL is fine, and
  // the artifact is still refused.
  const release = announcement(bytes, { version: "0.2.0", sig: signDigestOf(bytes, impostor.privateKey) });
  const result = await node.engine.applyRelease(release);

  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature_invalid");
  assert.ok(node.reasons("update_verify_failed").includes("signature_invalid"));
  assert.ok(node.engine.isPoisoned({ sha256: sha256Hex(bytes) }));
  assert.equal(node.engine.pendingVersion(), null);
  assert.deepEqual(fs.readdirSync(node.engine.paths.downloadDir), []);
  assert.equal(node.currentVersion(), "0.1.0", "nothing was unpacked, so nothing could be flipped to");
});

test("a malformed signature is refused without being mistaken for a verification pass", async () => {
  const bytes = Buffer.from("truncated-sig");
  const node = makeNode({ fetchImpl: servingArtifact(bytes) });
  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0", sig: "AAAA" }));
  assert.equal(result.reason, "signature_malformed");
  assert.ok(node.engine.isPoisoned({ sha256: sha256Hex(bytes) }));
});

// A missing key is a fault in THIS node's installation, not in the artifact.
// Poisoning it would make the node refuse that release forever — including
// after the operator repairs the key — which is a self-inflicted permanent
// outage of the update path.
test("a missing public key refuses the artifact but does NOT poison it", async () => {
  const bytes = Buffer.from("well-signed");
  const node = makeNode({ publicKey: null, fetchImpl: servingArtifact(bytes) });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "no_public_key");
  assert.ok(node.reasons("update_verify_failed").includes("no_public_key"));
  assert.equal(node.engine.isPoisoned({ sha256: sha256Hex(bytes) }), null);
  assert.equal(node.engine.isPoisoned({ version: "0.2.0" }), null);

  // Repair the key and the same announcement now applies.
  fs.writeFileSync(node.publicKeyFile, releasePublicKeyPem);
  const repaired = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(repaired.ok, true, "the release must still be installable once the key is in place");
});

test("a non-200 from the release host is inert, and an oversized artifact is refused before it is written", async () => {
  const bytes = Buffer.from("x".repeat(4096));

  const missing = makeNode({ fetchImpl: async () => ({ status: 404, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }) });
  const notFound = await missing.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(notFound.ok, false);
  assert.equal(notFound.reason, "download_status_404");
  assert.equal(missing.currentVersion(), "0.1.0");

  const huge = makeNode({ fetchImpl: servingArtifact(bytes), maxArtifactBytes: 16 });
  const tooBig = await huge.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(tooBig.reason, "artifact_too_large");
  assert.ok(!fs.existsSync(huge.engine.paths.downloadDir) || fs.readdirSync(huge.engine.paths.downloadDir).length === 0);
});

// ---------------------------------------------------------------------------
// Step 3, "Stage". Beside the running copy, never over it — that is the
// prerequisite the old in-place install.sh upgrade could not satisfy.

test("a good artifact is verified, staged beside the running copy, and reported as pendingVersion", async () => {
  const bytes = Buffer.from("genuine-release-bytes");
  // Unsupervised, so the sequence stops right after the flip and the staged
  // state is still observable; the flip/restart/verify cycle has its own tests.
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    restartResult: { restarted: false, mode: "unsupervised" },
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.ok, true);

  const stagedDir = path.join(node.updateRoot, "releases", "0.2.0");
  assert.ok(fs.existsSync(path.join(stagedDir, "src", "index.mjs")), "the release must land in releases/<version>");
  assert.ok(fs.existsSync(path.join(stagedDir, "package.json")));
  assert.ok(
    fs.existsSync(path.join(node.updateRoot, "releases", "0.1.0", "src", "index.mjs")),
    "the running copy must still be there — there is nothing to roll back to otherwise",
  );
  assert.equal(node.engine.pendingVersion(), "0.2.0");
  assert.ok(node.auditEvents().includes("update_verified"));
  assert.ok(node.auditEvents().includes("update_staged"));
  const staged = node.audits.find((entry) => entry.event === "update_staged");
  assert.equal(staged.version, "0.2.0");
  assert.equal(staged.sha256, sha256Hex(bytes), "the staged record names the digest that was verified");
});

test("a staged version survives a restart, because it is recorded on disk rather than in memory", async () => {
  const bytes = Buffer.from("staged-across-restart");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    // Never idle, so the apply stops after staging with the drain window
    // expired — the exact state `pendingVersion` exists to make visible.
    activeWork: async () => ({ ok: true, jobs: 1, terminals: 0 }),
    drainWaitMs: 0,
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "drain_window_expired");
  assert.equal(node.engine.pendingVersion(), "0.2.0");

  // A fresh engine over the same state dir stands in for the daemon after a
  // restart: it must still know something is staged, which is what the
  // heartbeat reports so a node stuck mid-update is visible rather than silent.
  const reborn = createUpdateEngine({ runningVersion: "0.1.0", updateRoot: node.updateRoot, stateDir: node.stateDir, audit: () => {} });
  assert.equal(reborn.pendingVersion(), "0.2.0");
});

test("an artifact whose tree carries a different version than was announced is refused and poisoned", async () => {
  const bytes = Buffer.from("lying-announcement");
  // Signed correctly, digest correct — and the bytes are 0.9.9, not the 0.2.0
  // the announcement claims. The signature covers the digest, not the version,
  // so this is the check that makes the two statements one.
  const node = makeNode({ artifactVersion: "0.9.9", fetchImpl: servingArtifact(bytes) });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "artifact_version_mismatch");
  assert.equal(result.detail.artifactVersion, "0.9.9");
  assert.ok(node.engine.isPoisoned({ sha256: sha256Hex(bytes) }));
  assert.ok(!fs.existsSync(path.join(node.updateRoot, "releases", "0.2.0")), "nothing may be left staged");
  assert.equal(node.currentVersion(), "0.1.0");
});

test("an artifact that is not a relayd tree is refused rather than flipped to", async () => {
  const bytes = Buffer.from("tarball-of-nothing");
  const node = makeNode({
    fetchImpl: servingArtifact(bytes),
    extract: async (_file, destDir) => {
      fs.mkdirSync(path.join(destDir, "random"), { recursive: true });
      fs.writeFileSync(path.join(destDir, "random", "file.txt"), "not relayd");
    },
  });
  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "artifact_not_relayd");
  assert.equal(node.currentVersion(), "0.1.0");
});

test("an extraction failure leaves no staging directory behind and does not move current", async () => {
  const bytes = Buffer.from("bad-gzip");
  const node = makeNode({ extractFails: true, fetchImpl: servingArtifact(bytes) });
  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "extract_failed");
  assert.deepEqual(
    fs.readdirSync(path.join(node.updateRoot, "releases")).filter((entry) => entry.startsWith(".staging")),
    [],
  );
  assert.equal(node.currentVersion(), "0.1.0");
});

// ---------------------------------------------------------------------------
// Step 4, "Drain". relayd holds job runs, SSE streams and terminal sessions,
// so a restart is visible on the phone mid-sentence.

test("the drain waits while a job is active and proceeds the moment the node is idle", async () => {
  const bytes = Buffer.from("wait-for-me");
  let looks = 0;
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    activeWork: async () => {
      looks += 1;
      return looks < 4 ? { ok: true, jobs: 1, terminals: 0 } : { ok: true, jobs: 0, terminals: 0 };
    },
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.ok, true, "the apply must complete once the job finishes");
  assert.equal(node.currentVersion(), "0.2.0");
  assert.ok(looks >= 4, "the drain must keep looking rather than deciding once");
  const waiting = node.audits.find((entry) => entry.event === "update_drain_waiting");
  assert.equal(waiting?.jobs, 1, "the wait is audited with what was live");
});

test("an attached terminal blocks the restart exactly like an active job does", async () => {
  const bytes = Buffer.from("terminal-open");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    activeWork: async () => ({ ok: true, jobs: 0, terminals: 1 }),
    drainWaitMs: 0,
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "drain_window_expired");
  assert.equal(node.currentVersion(), "0.1.0", "current must not move while a terminal is live");
  assert.deepEqual(node.restarts, []);
  const expired = node.audits.find((entry) => entry.event === "update_drain_expired");
  assert.equal(expired.terminals, 1);

  // Stays staged, so the next poll — the announcement is state and re-states
  // itself — applies it without downloading anything again.
  assert.equal(node.engine.pendingVersion(), "0.2.0");
  const retry = await node.engine.applyStaged({ version: "0.2.0", dir: path.join(node.updateRoot, "releases", "0.2.0") }, { force: true });
  assert.equal(retry.ok, true);
  assert.equal(node.currentVersion(), "0.2.0");
});

test("--now skips the drain wait instead of being blocked by live work", async () => {
  const bytes = Buffer.from("right-now");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    activeWork: async () => ({ ok: true, jobs: 2, terminals: 3 }),
    drainWaitMs: 60_000,
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }), { force: true });
  assert.equal(result.ok, true);
  assert.equal(node.currentVersion(), "0.2.0");
  assert.ok(node.auditEvents().includes("update_drain_skipped"), "an override must be visible after the fact");
});

// ---------------------------------------------------------------------------
// Steps 5-7. Flip, restart, verify the node's own /healthz reports the NEW
// version, and roll back if it does not.

test("a successful apply flips current, restarts once, verifies the new version, and clears the staged state", async () => {
  const bytes = Buffer.from("this-one-works");
  const events = [];
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    healthWaitMs: 5_000,
    postEvent: (type) => events.push(type),
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0", notes: "faster threads" }));

  assert.equal(result.ok, true);
  assert.equal(result.version, "0.2.0");
  assert.equal(node.currentLink(), "releases/0.2.0", "the symlink target stays relative so the tree is relocatable");
  assert.deepEqual(node.restarts, ["relayd-test.service"], "exactly one restart for one apply");
  assert.equal(node.engine.pendingVersion(), null, "an applied release is no longer pending");
  assert.ok(!fs.existsSync(node.engine.paths.applyingPath), "the in-flight record must be cleared");
  const applied = node.audits.find((entry) => entry.event === "update_applied");
  assert.deepEqual({ from: applied.from, to: applied.to }, { from: "0.1.0", to: "0.2.0" });
  assert.deepEqual(events, ["node.updated"], "a successful apply tells the phone");
});

test("a failed post-restart health check rolls current back, restarts again, and poisons the version", async () => {
  const bytes = Buffer.from("boots-but-lies");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    // The node comes back still reporting 0.1.0 — the old build answering on
    // the same port, which is exactly the failure the version check exists to
    // catch. "Something answered /healthz" is not enough.
    healthVersion: "0.1.0",
    healthWaitMs: 0,
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "health_check_failed");
  assert.equal(result.rolledBack, true);
  assert.equal(node.currentLink(), "releases/0.1.0", "current must point back at the release that was working");
  assert.equal(node.restarts.length, 2, "one restart into the new build, one back out of it");
  assert.ok(node.engine.isPoisoned({ version: "0.2.0" }),
    "the failed version must not be retried on the very next poll, which re-states the same announcement");
  assert.equal(node.engine.pendingVersion(), null);
  assert.ok(node.auditEvents().includes("update_health_failed"));
  assert.ok(node.auditEvents().includes("update_rolled_back"));

  // The poisoning is what closes the loop: the same announcement again stops
  // at the decision, before any download.
  const repeat = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(repeat.reason, "poisoned");
});

test("a restart that throws is treated as a failed apply and rolled back", async () => {
  const bytes = Buffer.from("systemctl-explodes");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    restartResult: new Error("simulated_systemctl_failure"),
  });
  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "restart_failed");
  assert.equal(node.currentLink(), "releases/0.1.0");
});

// The documented fallback: with no supervisor there is nothing to bring relayd
// back, so exiting would turn an update into an outage. `current` is flipped,
// the state is kept, and the operator restarts.
test("an unsupervised node flips and stays staged rather than taking itself down", async () => {
  const bytes = Buffer.from("no-systemd-here");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    restartResult: { restarted: false, mode: "unsupervised" },
  });

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.ok, true);
  assert.equal(result.restarted, false);
  assert.equal(node.currentLink(), "releases/0.2.0");
  assert.equal(node.engine.pendingVersion(), "0.2.0", "still pending: nothing has actually restarted into it yet");
  assert.ok(node.auditEvents().includes("update_restart_deferred"));

  // The operator restarts; the new process confirms the apply itself. Under
  // real systemd this is the NORMAL path, because the restart kills the
  // process that was applying.
  const confirmed = createUpdateEngine({
    runningVersion: "0.2.0",
    updateRoot: node.updateRoot,
    stateDir: node.stateDir,
    audit: () => {},
  });
  const resumed = await confirmed.resumePendingApply();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.version, "0.2.0");
  assert.equal(confirmed.pendingVersion(), null);
});

test("resuming after a restart that came up on the wrong version rolls back", async () => {
  const bytes = Buffer.from("crashed-into-the-old-one");
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    restartResult: { restarted: false, mode: "unsupervised" },
  });
  await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(node.currentLink(), "releases/0.2.0");

  const audits = [];
  const restarts = [];
  const reborn = createUpdateEngine({
    runningVersion: "0.1.0",
    updateRoot: node.updateRoot,
    stateDir: node.stateDir,
    audit: (event, _job, extra = {}) => audits.push({ event, ...extra }),
    restart: async () => {
      restarts.push("restart");
      return { restarted: true, mode: "systemd" };
    },
  });
  const resumed = await reborn.resumePendingApply();

  assert.equal(resumed.ok, false);
  assert.equal(resumed.reason, "health_check_failed");
  assert.equal(node.currentLink(), "releases/0.1.0");
  assert.equal(restarts.length, 1);
  assert.ok(reborn.isPoisoned({ version: "0.2.0" }));
});

test("resumePendingApply is a no-op when no apply is in flight", async () => {
  const node = makeNode();
  const resumed = await node.engine.resumePendingApply();
  assert.equal(resumed.ok, true);
  assert.equal(resumed.skipped, "nothing_pending");
  assert.deepEqual(node.restarts, []);
});

// A `current` that is a real directory means the node was installed by
// something that does not use this layout. Replacing it would delete the
// running copy with no way back.
test("a current path that is not a symlink is refused rather than clobbered", async () => {
  const bytes = Buffer.from("legacy-layout");
  const node = makeNode({ artifactVersion: "0.2.0", fetchImpl: servingArtifact(bytes) });
  fs.rmSync(path.join(node.updateRoot, "current"));
  fs.mkdirSync(path.join(node.updateRoot, "current"));

  const result = await node.engine.applyRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(result.reason, "current_not_a_symlink");
  assert.ok(fs.statSync(path.join(node.updateRoot, "current")).isDirectory(), "the operator's directory must survive");
  assert.deepEqual(node.restarts, []);
});

// ---------------------------------------------------------------------------
// `relayd update --file`: the same path with no cloud involved at all.

test("a local artifact applies through the same path, and its signature is still mandatory", async () => {
  const bytes = Buffer.from("hand-carried-release");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-update-local-"));
  const file = path.join(dir, "relayd-0.2.0.tar.gz");
  fs.writeFileSync(file, bytes);

  // No signature anywhere: refused. A local artifact is not more trusted than
  // an announced one — the offline signing key is the entire trust story.
  const unsigned = makeNode({ artifactVersion: "0.2.0" });
  assert.equal((await unsigned.engine.applyLocalFile(file)).reason, "no_signature");
  assert.equal(unsigned.currentVersion(), "0.1.0");

  // Signed by the wrong key: still refused.
  const impostor = crypto.generateKeyPairSync("ed25519");
  const wrong = makeNode({ artifactVersion: "0.2.0" });
  assert.equal(
    (await wrong.engine.applyLocalFile(file, { sig: signDigestOf(bytes, impostor.privateKey) })).reason,
    "signature_invalid",
  );

  // The sidecar the signing step writes alongside the artifact.
  fs.writeFileSync(`${file}.sig`, `${signDigestOf(bytes)}\n`);
  const node = makeNode({ artifactVersion: "0.2.0", healthWaitMs: 5_000 });
  const result = await node.engine.applyLocalFile(file);
  assert.equal(result.ok, true);
  assert.equal(result.version, "0.2.0", "the version comes from the artifact itself, not from a flag");
  assert.equal(node.currentVersion(), "0.2.0");
  assert.deepEqual(node.restarts, ["relayd-test.service"]);
});

// An operator with a shell on the machine installing an older build on purpose
// is the recovery path, so the announcement-time downgrade refusal does not
// apply — but it is loudly audited, because a silent downgrade is how the
// refusal stops meaning anything.
test("a local downgrade is allowed and audited, unlike an announced one", async () => {
  const bytes = Buffer.from("recovery-artifact");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-update-rollback-"));
  const file = path.join(dir, "relayd-0.1.0.tar.gz");
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.sig`, signDigestOf(bytes));

  const node = makeNode({ runningVersion: "0.3.0", artifactVersion: "0.1.0", healthWaitMs: 5_000 });
  const result = await node.engine.applyLocalFile(file);
  assert.equal(result.ok, true);
  assert.equal(node.currentVersion(), "0.1.0");
  const override = node.audits.find((entry) => entry.event === "update_local_override");
  assert.equal(override.version, "0.1.0");
  assert.equal(override.running, "0.3.0");
});

test("an unreadable local artifact is a clean refusal", async () => {
  const node = makeNode();
  assert.equal((await node.engine.applyLocalFile("/nonexistent/relayd.tar.gz")).reason, "artifact_unreadable");
});

// ---------------------------------------------------------------------------
// handleRelease — what onRelease is wired to.

test("auto-apply off records and reports the announcement but installs nothing", async () => {
  const bytes = Buffer.from("operator-decides");
  const node = makeNode({ autoApply: false, artifactVersion: "0.2.0", fetchImpl: servingArtifact(bytes) });

  const result = await node.engine.handleRelease(announcement(bytes, { version: "0.2.0", notes: "ready when you are" }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, "auto_update_disabled");
  assert.equal(node.currentVersion(), "0.1.0");
  assert.equal(node.engine.pendingVersion(), null);

  // But the node still LEARNS about it, which is what `relayd update --check`
  // prints and what makes the operator's decision an informed one.
  const status = node.engine.status();
  assert.equal(status.announced.version, "0.2.0");
  assert.equal(status.announced.notes, "ready when you are");
  assert.equal(status.autoApply, false);
});

// The poll re-states the same announcement every cycle, because it is state
// and not a message. Without deduplication that is an audit line and a state
// write every wait window, forever.
test("an unchanged announcement is recorded once, not once per poll", async () => {
  const bytes = Buffer.from("same-old-news");
  const node = makeNode({ runningVersion: "0.3.0" });
  const release = announcement(bytes, { version: "0.2.0" });

  for (let poll = 0; poll < 5; poll++) await node.engine.handleRelease(release);
  assert.equal(node.audits.filter((entry) => entry.event === "update_release_seen").length, 1);

  // A genuinely new announcement is recorded again.
  await node.engine.handleRelease(announcement(bytes, { version: "0.4.0" }));
  assert.equal(node.audits.filter((entry) => entry.event === "update_release_seen").length, 2);
});

// The poll awaits onRelease, the handoff loop awaits the poll, and an apply
// spans a drain window measured in minutes plus a restart. Awaiting the apply
// inside the handler would stall handoff pickup and credential sync for that
// whole window — the update path taking a healthy node's other work down with
// it, which is the one thing it must never do.
test("handleRelease returns before the apply finishes, so a drain window cannot stall the poll loop", async () => {
  const bytes = Buffer.from("takes-its-time");
  let releaseDrain;
  const drainGate = new Promise((resolve) => { releaseDrain = resolve; });
  let looks = 0;
  const node = makeNode({
    artifactVersion: "0.2.0",
    fetchImpl: servingArtifact(bytes),
    activeWork: async () => {
      looks += 1;
      if (looks === 1) return { ok: true, jobs: 1, terminals: 0 };
      await drainGate;
      return { ok: true, jobs: 0, terminals: 0 };
    },
  });

  const handled = await node.engine.handleRelease(announcement(bytes, { version: "0.2.0" }));
  assert.equal(handled.ok, true);
  assert.equal(handled.started, true);
  assert.equal(node.currentVersion(), "0.1.0", "the handler must return while the apply is still draining");

  // A second announcement arriving mid-apply must not start a second one.
  const concurrent = await node.engine.handleRelease(announcement(bytes, { version: "0.3.0" }));
  assert.equal(concurrent.reason, "apply_in_flight");

  releaseDrain();
  const result = await handled.applied;
  assert.equal(result.ok, true);
  assert.equal(node.currentVersion(), "0.2.0");
});

test("status() reports the running build, the layout and the key without changing anything", () => {
  const node = makeNode({ runningVersion: "0.1.0", channel: "beta" });
  const before = fs.readdirSync(node.stateDir).sort();
  const status = node.engine.status();

  assert.equal(status.runningVersion, "0.1.0");
  assert.equal(status.channel, "beta");
  assert.equal(status.currentLink, "releases/0.1.0");
  assert.equal(status.publicKeyPresent, true);
  assert.equal(status.announced, null);
  assert.deepEqual(fs.readdirSync(node.stateDir).sort(), before, "--check must change nothing");
});
