// relayd handoff.mjs — the sandbox end of `relay handoff`.
//
// Pickup is a long-poll against the control plane, which learns only names.
// Everything with content comes over git: the branch carries the work, and two
// blobs sealed to this node's X25519 key carry the manifest and the session
// transcript. They are decrypted here and nowhere else.
//
// Every value in a handoff descriptor arrives over the network (the cloud's
// long-poll response, ultimately relayed from whatever pushed the handoff) and
// is treated as attacker-controlled: the id becomes a filesystem path segment,
// the repo becomes a clone URL, the branch becomes a `git clone --branch`
// argument. Each is validated before it touches a path or an argv array, and
// containment is re-verified against the REAL (symlink-resolved) filesystem
// state rather than a lexical path.resolve comparison — a lexical check only
// ever sees the string, so a pre-planted symlink at the checkout path defeats
// it trivially.
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
import { enqueueJob } from "./jobs.mjs";

const execFileAsync = promisify(execFile);
const MAX_BLOB_BYTES = 20 * 1024 * 1024;

// Deliberately a STRICT SUBSET of store.mjs's own record-id charset
// (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/): no dots, no leading-char exception —
// so any id this module accepts is guaranteed to also be accepted by
// store.saveHandoff, and the id can never contain the "/" or ".." that would
// let it navigate a path once joined.
const SAFE_HANDOFF_ID = /^[A-Za-z0-9_-]{1,128}$/;

// GitHub owner/repo shape only. Rejects anything that could turn the
// `https://github.com/<repo>.git` clone URL into a different host, a local
// path, or (since this string becomes one argv element passed to execFile,
// never a shell) an unexpected transport. No shell is involved so classic
// quoting/semicolon injection is not the risk here; a malformed repo string
// changing the URL's *meaning* is.
const SAFE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function assertSafeHandoffId(id) {
  if (typeof id !== "string" || !SAFE_HANDOFF_ID.test(id)) {
    throw Object.assign(new Error("invalid_handoff_id"), { status: 400 });
  }
  return id;
}

function assertSafeRepo(repo) {
  if (typeof repo !== "string" || !SAFE_REPO.test(repo) || repo.includes("..")) {
    throw Object.assign(new Error("invalid_repo"), { status: 400 });
  }
  return repo;
}

// Loose but real: rejects empty/oversized/whitespace/control-character
// branch names, a leading "-" (which would otherwise sit as the first byte
// of the `--branch` argument's value), and "..". Not a full
// `git check-ref-format` — this only needs to be safe as an execFile argv
// element and as a value later reused as a `git push origin <branch>`
// argument, not a complete ref-name validator.
function assertSafeBranch(branch) {
  if (typeof branch !== "string" || branch.length === 0 || branch.length > 255) {
    throw Object.assign(new Error("invalid_branch"), { status: 400 });
  }
  if (/[\0-\x1f\s]/.test(branch) || branch.includes("..") || branch.startsWith("-")) {
    throw Object.assign(new Error("invalid_branch"), { status: 400 });
  }
  return branch;
}

// <workspaceBrowseRoot>/handoff-<id first 12 chars>. workspaceBrowseRoot is
// realpath-resolved once at config load; assertSafeHandoffId guarantees the
// id contains no "/" and no ".", so the leaf this produces is always a single
// literal path segment — path.join cannot be walked out of the root by the
// id's content alone, regardless of what an attacker puts in it.
function checkoutPathFor(handoffId) {
  const safeId = assertSafeHandoffId(handoffId).slice(0, 12);
  return path.join(workspaceBrowseRoot, `handoff-${safeId}`);
}

// Verifies the checkout directory is REALLY inside workspaceBrowseRoot, by
// asking the filesystem (fs.realpathSync) rather than comparing strings. A
// sibling task in this plan shipped a lexical path.resolve() containment
// check here instead, and a pre-planted symlink at the checkout path defeated
// it (the lexical check never resolves the symlink, so it only ever
// validates the string, not what it actually points at). fs.rmSync on a
// symlink unlinks the link itself rather than following it, so a pre-planted
// symlink at this exact leaf is removed, not walked into, before the clone —
// this call is the defense-in-depth re-check afterwards.
function assertRealContainment(candidate) {
  const real = fs.realpathSync(candidate);
  if (!resolvedPathWithinRoot(real)) {
    throw new Error("checkout_outside_jail");
  }
  return real;
}

function nowIso() {
  return new Date().toISOString();
}

function persist(record) {
  store.saveHandoff(record);
  return record;
}

async function failHandoff(record, error, cloud) {
  const failed = persist({ ...record, state: "failed", error: String(error), updatedAt: nowIso() });
  appendAudit("handoff_failed", { id: record.id }, { error: String(error) });
  emitEvent("handoff.failed", { id: record.id, repo: record.repo, error: String(error) });
  await cloud?.postEvent?.("handoff.failed").catch(() => {});
  return failed;
}

// Reads one sealed blob out of the (already containment-verified) checkout.
// realpath-checks the blob path itself too: the checkout directory is ours,
// but its CONTENTS come from a remote-supplied git branch, and a malicious
// commit could plant a symlink at .relay/handoff/<id>/<name> aimed outside
// the checkout. Falling through to statSync/readFileSync would then read
// whatever that symlink points at.
function readSealed(checkout, handoffId, name) {
  const filePath = path.join(checkout, ".relay", "handoff", handoffId, name);
  const real = fs.realpathSync(filePath); // ENOENT propagates with .code intact
  const realCheckout = fs.realpathSync(checkout);
  if (real !== realCheckout && !real.startsWith(`${realCheckout}${path.sep}`)) {
    throw new Error(`blob_outside_checkout_${name}`);
  }
  const stat = fs.statSync(real);
  if (stat.size > MAX_BLOB_BYTES) throw new Error(`blob_too_large_${name}`);
  return fs.readFileSync(real);
}

async function importHandoff(descriptor, options = {}) {
  const {
    cloud = null,
    baseDir = undefined,
    runHome = configuredRunHome,
    execFileImpl = execFileAsync,
    remoteUrlFor = (repo) => `https://github.com/${repo}.git`,
  } = options;

  const rawId = descriptor?.id;

  // Validated before it ever touches the store or a path. A bad id can't even
  // be safely persisted as a "failed" record under itself (store.saveHandoff
  // has its own, more permissive validator, and this module must not lean on
  // that as an implicit safety net) — so this is announced without a store
  // write, never silently dropped.
  let id;
  try {
    id = assertSafeHandoffId(rawId);
  } catch {
    const reason = "invalid_handoff_id";
    appendAudit("handoff_failed", { id: null }, { reason, repo: descriptor?.repo ?? null });
    emitEvent("handoff.failed", { id: null, repo: descriptor?.repo ?? null, error: reason });
    await cloud?.postEvent?.("handoff.failed").catch(() => {});
    return { id: typeof rawId === "string" ? rawId : null, state: "failed", error: reason };
  }

  const existing = store.getHandoff(id);
  if (existing && existing.state === "ready") return existing;

  let record = persist({
    id, state: "importing", repo: descriptor.repo, branch: descriptor.branch,
    workspaceId: null, provider: null, resumeSessionId: null, primedPrompt: null,
    title: descriptor.branch, manifest: null, lastJobId: null, error: null,
    createdAt: existing?.createdAt || nowIso(), updatedAt: nowIso(),
  });

  let checkout;
  try {
    const repo = assertSafeRepo(descriptor.repo);
    const branch = assertSafeBranch(descriptor.branch);
    checkout = checkoutPathFor(id);
    // fs.rmSync on a symlink removes the link itself, never the directory it
    // points at, so a pre-planted symlink at this leaf is cleared here rather
    // than followed by the clone below.
    fs.rmSync(checkout, { recursive: true, force: true });
    await execFileImpl(gitBin, [
      "clone", "--quiet", "--branch", branch, "--single-branch", "--depth", "50",
      remoteUrlFor(repo), checkout,
    ], { env: { ...process.env, HOME: runHome, GIT_TERMINAL_PROMPT: "0" } });
    checkout = assertRealContainment(checkout);
  } catch (error) {
    return failHandoff(record, `clone_failed: ${error?.message || error}`, cloud);
  }

  let manifest = null;
  let sessionBytes = null;
  try {
    const privateKeyPem = readEncPrivateKeyPem(baseDir ? identityPaths(baseDir) : identityPaths());
    if (!privateKeyPem) throw new Error("no_encryption_key");
    manifest = JSON.parse(openSealed(privateKeyPem, readSealed(checkout, id, "manifest.enc")).toString("utf8"));
    if (manifest?.v !== 1) throw new Error("unsupported_manifest_version");
    try {
      sessionBytes = openSealed(privateKeyPem, readSealed(checkout, id, "session.enc"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      sessionBytes = null;
    }
  } catch (error) {
    return failHandoff(record, error?.message || String(error), cloud);
  }

  const workspace = browseWorkspaceForPath(checkout, { materialize: true });
  if (!workspace) return failHandoff(record, "workspace_registration_failed", cloud);

  const staged = importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath: checkout });

  record = persist({
    ...record,
    state: "ready",
    workspaceId: workspace.id,
    provider: staged.provider,
    resumeSessionId: staged.resumeSessionId,
    primedPrompt: staged.primedPrompt,
    title: manifest.title || descriptor.branch,
    manifest,
    updatedAt: nowIso(),
  });

  appendAudit("handoff_ready", { id: record.id }, { repo: record.repo, provider: record.provider });
  emitEvent("handoff.ready", { id: record.id, repo: record.repo, title: record.title, provider: record.provider });
  await cloud?.postEvent?.("handoff.ready").catch(() => {});
  return record;
}

async function continueHandoff(id, { prompt = null, certSubject = null } = {}) {
  const record = store.getHandoff(id);
  if (!record) throw Object.assign(new Error("handoff not found"), { status: 404 });
  if (record.state !== "ready") throw Object.assign(new Error("handoff is not ready"), { status: 409 });

  const job = enqueueJob({
    workspaceId: record.workspaceId,
    provider: record.provider,
    prompt: prompt || record.primedPrompt || "Continue where the handed-off session left off.",
    resumeSessionId: record.resumeSessionId || undefined,
  }, certSubject);

  persist({ ...record, lastJobId: job.id, updatedAt: nowIso() });
  return job;
}

// Called from finishJob. A handoff job's commits belong on the handoff branch,
// so a successful run commits and pushes there — never force, never elsewhere.
async function completeHandoffJob(job) {
  const record = store.listHandoffs().find((entry) => entry.lastJobId === job.id);
  if (!record || job.status !== "succeeded") return null;

  const checkout = checkoutPathFor(record.id);
  const git = (...args) => execFileAsync(gitBin, ["-C", checkout, ...args],
    { env: { ...process.env, HOME: configuredRunHome, GIT_TERMINAL_PROMPT: "0" } });
  try {
    const status = await git("status", "--porcelain");
    if (status.stdout.trim()) {
      await git("-c", "user.name=relayd", "-c", "user.email=relayd@localhost", "add", "-A");
      await git("-c", "user.name=relayd", "-c", "user.email=relayd@localhost", "commit", "-m", `relay: job ${job.id}`);
    }
    await git("push", "origin", record.branch);
    appendAudit("handoff_pushed", { id: record.id }, { branch: record.branch, jobId: job.id });
    return { branch: record.branch, pushed: true };
  } catch (error) {
    appendAudit("handoff_push_failed", { id: record.id }, { error: error?.message || String(error) });
    return { branch: record.branch, pushed: false };
  }
}

function startHandoffLoop({ cloud, waitSec }) {
  let stopped = false;
  (async () => {
    let backoffMs = 1000;
    while (!stopped) {
      try {
        const descriptors = await cloud.pollHandoffs(waitSec);
        backoffMs = 1000;
        for (const descriptor of descriptors) {
          if (stopped) break;
          await importHandoff(descriptor, { cloud });
        }
      } catch (error) {
        appendAudit("handoff_poll_failed", { id: "loop" }, { error: error?.message || String(error) });
        await new Promise((resolve) => setTimeout(resolve, backoffMs).unref?.());
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  })();
  return { stop() { stopped = true; } };
}

export { importHandoff, continueHandoff, completeHandoffJob, startHandoffLoop, checkoutPathFor };
