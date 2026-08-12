// END TO END: a credential typed on the laptop arrives installed inside the
// sandbox.
//
// Every other test in this feature exercises one side against a fake of the
// other, which is exactly how the gap this closes survived a whole round: the
// CLI's tests proved a blob was PUT, relayd's proved a bundle could be
// INSTALLED, and nothing anywhere proved the two halves were connected. This
// test runs the real `relay sync-auth` command against the real cloud HTTP
// server, then drives the real relayd collector from the real node long-poll
// response, and asserts the exact token string the CLI collected is on disk
// in the runner home at 0600.
//
// It lives in the cloud suite because the cloud is the only party both halves
// talk to, and because startTestApp already stands up the real server. It
// imports the sibling packages by relative path — there are no npm
// dependencies anywhere in this repo, so a plain import is the whole story.

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startTestApp, api, signIn } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";

// relayd reads its configuration at import time and mkdirs what it is
// pointed at, so this has to be set before the dynamic imports below —
// the same preamble product/relayd/test/*.test.mjs use.
const RELAYD_SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-relayd-"));
process.env.CODEX_DATA_DIR ||= path.join(RELAYD_SCRATCH, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT ||= path.join(RELAYD_SCRATCH, "workspaces");
process.env.CODEX_WORKSPACES ||= JSON.stringify([
  { id: "welcome", name: "Welcome", path: path.join(RELAYD_SCRATCH, "workspaces", "welcome") },
]);
process.env.CODEX_RUN_HOME ||= path.join(RELAYD_SCRATCH, "runhome");

// The laptop half.
const { cmdSyncAuth } = await import("../../cli/src/commands/syncauth.mjs");
const { writeCredentials } = await import("../../cli/src/creds.mjs");
// The sandbox half.
const { installFromNotice, readMacSessions } = await import("../../relayd/src/syncauth.mjs");
const { identityPaths } = await import("../../relayd/src/identity.mjs");
const { generateEncKeyPair } = await import("../../relayd/src/seal.mjs");

const NODE_ID = "node-aabbccddeeff0011";

// The one credential this test follows all the way through. Distinctive
// enough that it can be searched for in places it must never appear.
const GITHUB_TOKEN = "ghp_end_to_end_credential_MARKER_do_not_leak";
const CLAUDE_CREDENTIALS = '{"accessToken":"claude_end_to_end_MARKER"}';
const CODEX_AUTH = '{"OPENAI_API_KEY":"codex_end_to_end_MARKER"}';

// A node identity as relayd would have after enroll: an ed25519 key it signs
// poll requests with, and an X25519 keypair whose public half the cloud
// serves and whose private half only the node holds. Written directly rather
// than through initIdentity so this test needs no openssl binary.
function sandboxIdentity() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-identity-"));
  fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  const signing = crypto.generateKeyPairSync("ed25519");
  const encryption = generateEncKeyPair();
  const paths = identityPaths(baseDir);
  fs.writeFileSync(paths.encKeyPath, encryption.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(paths.encPubPath, `${encryption.publicKeyB64}\n`, { mode: 0o600 });
  return {
    baseDir,
    privateKey: signing.privateKey,
    pubkeyPem: signing.publicKey.export({ type: "spki", format: "pem" }).toString(),
    encPubkeyB64: encryption.publicKeyB64,
  };
}

function nodeHeaders(identity, { method, pathWithQuery, ts }) {
  const signature = crypto.sign(null,
    nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId: NODE_ID }), identity.privateKey);
  return {
    headers: {
      "x-relay-node": NODE_ID,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    },
  };
}

// Every TEXT value the cloud has stored, so a credential can be searched for
// across the whole control plane rather than in the one table this test
// happens to think about.
function everyStoredValue(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  const values = [];
  for (const { name } of tables) {
    for (const row of db.prepare(`SELECT * FROM ${name}`).all()) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") values.push(value);
      }
    }
  }
  return values;
}

test("a credential collected by relay sync-auth on the laptop ends up installed inside the sandbox", async () => {
  const t = await startTestApp();
  const identity = sandboxIdentity();
  const laptopHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-laptop-"));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-sandbox-"));
  const runHome = path.join(sandbox, "home");
  const codexHome = path.join(sandbox, "codex");
  const dataDir = path.join(sandbox, "data");

  try {
    // ── the account, and the machine the cloud tells the laptop about ──────
    const session = await signIn(t);
    t.app.registry.createNode(session.accountId, {
      id: NODE_ID, kind: "trial", name: "Trial machine",
      pubkey: identity.pubkeyPem, encPubkey: identity.encPubkeyB64,
    });

    // ── the laptop: signed in, machine pinned, logins present ─────────────
    writeCredentials({
      sessionToken: session.sessionToken, accountId: session.accountId,
      nodeId: NODE_ID, nodeEncPubkey: identity.encPubkeyB64,
    }, { home: laptopHome });
    fs.mkdirSync(path.join(laptopHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(laptopHome, ".claude", ".credentials.json"), CLAUDE_CREDENTIALS);
    fs.mkdirSync(path.join(laptopHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(laptopHome, ".codex", "auth.json"), CODEX_AUTH);

    // ── `relay sync-auth`, for real, against the real server ──────────────
    const printed = [];
    const result = await cmdSyncAuth([], {
      home: laptopHome,
      baseUrl: t.baseUrl,
      log: (line) => printed.push(line),
      execFileImpl: async () => ({ stdout: `${GITHUB_TOKEN}\n` }),
      // Not inside a repo for the purposes of this run: the session-index
      // half is covered by its own leg below.
      requireGitHubRepoImpl: async () => { throw new Error("not a repo"); },
    });
    assert.deepEqual(result.installed.sort(), ["claude", "codex", "github"]);
    assert.ok(!printed.join("\n").includes(GITHUB_TOKEN), "the command never prints a credential");

    // ── the sandbox polls, exactly as relayd's cloud client does ──────────
    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath,
      nodeHeaders(identity, { method: "GET", pathWithQuery: pollPath, ts: t.clock.t }));
    assert.equal(poll.status, 200);
    assert.equal(poll.json.notices.length, 1, "the sandbox must be told a bundle is waiting for it");
    const notice = poll.json.notices[0];

    // ── the sandbox collects, verifies the MAC, unseals and installs ──────
    const installed = await installFromNotice(notice, {
      cloudUrl: t.baseUrl, runHome, codexHome, dataDir,
      identityBaseDir: identity.baseDir,
      emit: () => {},
    });
    assert.equal(installed.ok, true, `install failed: ${installed.reason}`);
    assert.deepEqual(installed.installed.sort(), ["claude", "codex", "github"]);

    // ── THE CLAIM: the exact bytes the laptop collected are on the sandbox ─
    const gitCredentials = path.join(runHome, ".git-credentials");
    assert.equal(fs.readFileSync(gitCredentials, "utf8").trim(),
      `https://x-access-token:${GITHUB_TOKEN}@github.com`);
    assert.equal(fs.statSync(gitCredentials).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runHome).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(runHome, ".claude", ".credentials.json"), "utf8"), CLAUDE_CREDENTIALS);
    assert.equal(fs.statSync(path.join(runHome, ".claude", ".credentials.json")).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), CODEX_AUTH);
    assert.equal(fs.statSync(path.join(codexHome, "auth.json")).mode & 0o777, 0o600);

    // ── and no credential ever existed in cleartext on the control plane ──
    const stored = everyStoredValue(t.app.db);
    for (const marker of [GITHUB_TOKEN, "claude_end_to_end_MARKER", "codex_end_to_end_MARKER"]) {
      assert.ok(!stored.some((value) => value.includes(marker)),
        `${marker} must never appear anywhere in the control plane's database`);
    }
    // The blob the cloud DID store is the sealed one, and it is real
    // ciphertext rather than an accident of encoding.
    assert.ok(stored.some((value) => Buffer.from(value, "base64").subarray(0, 8).toString("utf8") === "RLYSEAL1"),
      "the cloud should be holding a sealed blob — otherwise this test proved nothing about the seal");

    // ── the ack closes the loop the same way a handoff's does ─────────────
    const ackPath = "/v1/node/handoffs/ack";
    t.clock.t += 1;
    const ack = await api(t.baseUrl, "POST", ackPath, {
      body: { notices: [{ id: notice.id, lease: notice.lease }] },
      ...nodeHeaders(identity, { method: "POST", pathWithQuery: ackPath, ts: t.clock.t }),
    });
    assert.deepEqual(ack.json.noticesAcked, [notice.id]);

    // ── second leg: the session index the phone renders ───────────────────
    const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-repo-")));
    const { claudeProjectSlug } = await import("../../cli/src/sessions.mjs");
    const sessionFile = path.join(laptopHome, ".claude", "projects", claudeProjectSlug(repoRoot), "s1.jsonl");
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile,
      `${JSON.stringify({ type: "user", message: { content: "fix the auth bug" } })}\n`);

    await cmdSyncAuth([], {
      home: laptopHome, baseUrl: t.baseUrl, log: () => {},
      execFileImpl: async () => { throw new Error("no gh"); },
      machine: "MacBook-Pro",
      requireGitHubRepoImpl: async () => ({ root: repoRoot, fullName: "acme/relay" }),
    });

    t.clock.t += 1;
    const secondPoll = await api(t.baseUrl, "GET", pollPath,
      nodeHeaders(identity, { method: "GET", pathWithQuery: pollPath, ts: t.clock.t }));
    // Two more rendezvous this round: the credential bundle again, and the
    // session index. Both must be announced.
    assert.equal(secondPoll.json.notices.length, 2);
    for (const pending of secondPoll.json.notices) {
      const outcome = await installFromNotice(pending, {
        cloudUrl: t.baseUrl, runHome, codexHome, dataDir,
        identityBaseDir: identity.baseDir, emit: () => {},
      });
      assert.equal(outcome.ok, true, `install failed: ${outcome.reason}`);
    }

    const index = readMacSessions({ dataDir });
    assert.equal(index.machine, "MacBook-Pro");
    assert.equal(index.sessions[0].repo, "acme/relay");
    assert.deepEqual(Object.keys(index.sessions[0]).sort(), ["harness", "id", "lastActive", "repo", "title"]);
  } finally {
    await t.close();
  }
});

// The other half of "every failure ends visibly": if the sandbox was offline
// while the rendezvous expired, the notice still arrives and the node still
// says so, out loud, instead of the user believing a sync landed.
test("a sync the sandbox slept through ends in a visible failure, not a silent one", async () => {
  const t = await startTestApp();
  const identity = sandboxIdentity();
  const laptopHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-laptop-late-"));
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-sandbox-late-"));

  try {
    const session = await signIn(t);
    t.app.registry.createNode(session.accountId, {
      id: NODE_ID, kind: "trial", name: "Trial machine",
      pubkey: identity.pubkeyPem, encPubkey: identity.encPubkeyB64,
    });
    writeCredentials({
      sessionToken: session.sessionToken, accountId: session.accountId,
      nodeId: NODE_ID, nodeEncPubkey: identity.encPubkeyB64,
    }, { home: laptopHome });

    await cmdSyncAuth([], {
      home: laptopHome, baseUrl: t.baseUrl, log: () => {},
      execFileImpl: async () => ({ stdout: `${GITHUB_TOKEN}\n` }),
      requireGitHubRepoImpl: async () => { throw new Error("not a repo"); },
    });

    // The sandbox comes back after the rendezvous TTL.
    t.clock.t += t.config.pairingTtlSec * 1000 + 1;
    t.app.runSweeps();

    const pollPath = "/v1/node/handoffs?wait=0";
    const poll = await api(t.baseUrl, "GET", pollPath,
      nodeHeaders(identity, { method: "GET", pathWithQuery: pollPath, ts: t.clock.t }));
    assert.equal(poll.json.notices.length, 1, "the notice must still arrive, so the failure can be reported");

    const events = [];
    const outcome = await installFromNotice(poll.json.notices[0], {
      cloudUrl: t.baseUrl,
      runHome: path.join(sandbox, "home"),
      codexHome: path.join(sandbox, "codex"),
      dataDir: path.join(sandbox, "data"),
      identityBaseDir: identity.baseDir,
      emit: (name, data) => events.push({ name, data }),
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "rendezvous_401", "an expired slot refuses the collect");
    assert.deepEqual(events.map((event) => event.name), ["credentials.failed"]);
    assert.match(events[0].data.action, /relay sync-auth/);
    assert.equal(fs.existsSync(path.join(sandbox, "home", ".git-credentials")), false);
  } finally {
    await t.close();
  }
});
