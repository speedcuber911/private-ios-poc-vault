// The control-plane half of the relayd release subscription: what a node
// reports about itself on POST /v1/node/heartbeat, what an operator publishes
// on POST /v1/admin/relayd-release, and the `release` object that rides the
// handoff long-poll out to every machine on the channel.
//
// Two properties carry most of this file's weight, because breaking either is
// silent in production. First, the heartbeat wire is already shipped: relayd
// sends the literal `{}` and an older relayd must keep working untouched, so
// nothing added to that body may turn a presence ping into an error. Second,
// `release` must be ABSENT rather than null when nothing is published — the
// spec's normative wire addition — which a truthiness assertion would pass
// while `{ release: null }` shipped.
//
// See docs/superpowers/specs/2026-09-21-relayd-release-subscription.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { startTestApp, api, signIn, TEST_ADMIN_TOKEN } from "./helpers.mjs";
import { nodeRequestSigningInput } from "../src/nodeauth.js";
import { createRegistry } from "../src/registry.js";

const NODE_ID = "node-00112233445566aa";
const BETA_NODE_ID = "node-00112233445566bb";

function nodeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pubkeyPem: publicKey.export({ type: "spki", format: "pem" }), privateKey };
}

function nodeHeaders(identity, { method = "GET", pathWithQuery, ts, nodeId = NODE_ID }) {
  const signature = crypto.sign(
    null,
    nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }),
    identity.privateKey,
  );
  return {
    headers: {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    },
  };
}

const adminAuth = { headers: { authorization: `Bearer ${TEST_ADMIN_TOKEN}` } };

// Exactly what ops/release-relayd POSTs: lowercase hex of the artifact digest,
// and base64url (unpadded) of an Ed25519 signature over the 32 raw digest
// bytes. Built with a real key so the canonical-base64url rule is tested
// against a real signature rather than a hand-written string that happens to
// be 86 characters long.
function releaseDescriptor(overrides = {}) {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const digest = crypto.createHash("sha256").update("relayd-artifact-bytes").digest();
  return {
    channel: "stable",
    version: "0.2.0",
    url: "https://releases.example.com/relayd/0.2.0/relayd-0.2.0.tar.gz",
    sha256: digest.toString("hex"),
    sigAlg: "ed25519",
    sig: crypto.sign(null, digest, privateKey).toString("base64url"),
    minVersion: "0.1.0",
    notes: null,
    ...overrides,
  };
}

async function setup() {
  const t = await startTestApp();
  const session = await signIn(t);
  const identity = nodeIdentity();
  t.app.registry.createNode(session.accountId, {
    id: NODE_ID, kind: "byo", name: "box", pubkey: identity.pubkeyPem,
  });
  return { t, session, identity };
}

async function heartbeat(t, identity, { body, raw } = {}) {
  const pathWithQuery = "/v1/node/heartbeat";
  t.clock.t += 1; // a distinct logical request, not a replay the guard must refuse
  return api(t.baseUrl, "POST", pathWithQuery, {
    ...(raw !== undefined ? { raw } : {}),
    ...(body !== undefined ? { body } : {}),
    ...nodeHeaders(identity, { method: "POST", pathWithQuery, ts: t.clock.t }),
  });
}

async function poll(t, identity, { nodeId = NODE_ID } = {}) {
  const pathWithQuery = "/v1/node/handoffs?wait=0";
  t.clock.t += 1;
  return api(t.baseUrl, "GET", pathWithQuery, nodeHeaders(identity, { pathWithQuery, ts: t.clock.t, nodeId }));
}

// ── heartbeat ─────────────────────────────────────────────────────────────

test("the already-shipped heartbeat body — the literal `{}` — still works and stores nothing", async () => {
  const { t, identity } = await setup();
  try {
    const before = t.app.registry.getNode(NODE_ID);
    assert.equal(before.lastSeen, null);

    const res = await heartbeat(t, identity, { raw: "{}" });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);

    const node = t.app.registry.getNode(NODE_ID);
    assert.ok(node.lastSeen > 0, "the ping must still record presence");
    assert.equal(node.version, null);
    assert.equal(node.channel, null);
    assert.equal(node.pendingVersion, null);
  } finally {
    await t.close();
  }
});

test("a heartbeat with no body at all, or an unparseable one, is still a successful ping", async () => {
  const { t, identity } = await setup();
  try {
    const empty = await heartbeat(t, identity);
    assert.equal(empty.status, 200);
    const afterEmpty = t.app.registry.getNode(NODE_ID).lastSeen;
    assert.ok(afterEmpty > 0);

    const garbage = await heartbeat(t, identity, { raw: "not json at all" });
    assert.equal(garbage.status, 200, "a heartbeat must never 4xx over its body");
    assert.ok(t.app.registry.getNode(NODE_ID).lastSeen > afterEmpty);
  } finally {
    await t.close();
  }
});

test("a heartbeat reporting version and channel stores them; null clears a staged version", async () => {
  const { t, identity } = await setup();
  try {
    let res = await heartbeat(t, identity, {
      body: { version: "0.1.0", channel: "beta", pendingVersion: "0.2.0" },
    });
    assert.equal(res.status, 200);
    let node = t.app.registry.getNode(NODE_ID);
    assert.equal(node.version, "0.1.0");
    assert.equal(node.channel, "beta");
    assert.equal(node.pendingVersion, "0.2.0");

    // The apply landed: the node is now running what it had staged, and says
    // so by reporting an explicit null. That must clear the column rather than
    // read as "no opinion" — a pendingVersion that cannot be retracted is a
    // machine that looks stuck mid-update forever.
    res = await heartbeat(t, identity, {
      body: { version: "0.2.0", channel: "beta", pendingVersion: null },
    });
    assert.equal(res.status, 200);
    node = t.app.registry.getNode(NODE_ID);
    assert.equal(node.version, "0.2.0");
    assert.equal(node.pendingVersion, null);

    // An omitted field leaves the stored value alone, which is what makes the
    // `{}` body above compatible rather than destructive.
    res = await heartbeat(t, identity, { body: {} });
    assert.equal(res.status, 200);
    node = t.app.registry.getNode(NODE_ID);
    assert.equal(node.version, "0.2.0");
    assert.equal(node.channel, "beta");
  } finally {
    await t.close();
  }
});

test("a malformed channel or version is ignored rather than refused, and is never stored", async () => {
  const { t, identity } = await setup();
  try {
    await heartbeat(t, identity, { body: { version: "0.1.0", channel: "stable" } });

    for (const channel of ["canary", "STABLE", " stable", "", 7, {}, ["beta"]]) {
      const res = await heartbeat(t, identity, { body: { channel } });
      assert.equal(res.status, 200, `channel ${JSON.stringify(channel)} must not fail the ping`);
      assert.equal(
        t.app.registry.getNode(NODE_ID).channel, "stable",
        `channel ${JSON.stringify(channel)} must not overwrite a good value`,
      );
    }

    // A NUL byte is the one that matters beyond tidiness: node:sqlite
    // truncates TEXT at the first NUL, so a stored value would not be the
    // value that passed validation.
    for (const version of ["0.1.0\u0000evil", "a".repeat(65), "../../etc/passwd", "", 3, {}]) {
      const res = await heartbeat(t, identity, { body: { version } });
      assert.equal(res.status, 200, `version ${JSON.stringify(version)} must not fail the ping`);
      assert.equal(
        t.app.registry.getNode(NODE_ID).version, "0.1.0",
        `version ${JSON.stringify(version)} must not be stored`,
      );
    }
  } finally {
    await t.close();
  }
});

// ── publishing ────────────────────────────────────────────────────────────

test("publishing accepts exactly what ops/release-relayd sends, including notes: null", async () => {
  const { t } = await setup();
  try {
    const descriptor = releaseDescriptor();
    const res = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: descriptor, ...adminAuth,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.release.version, "0.2.0");
    assert.equal(res.json.release.notes, null);
    assert.ok(res.json.release.publishedAt > 0);

    const read = await api(t.baseUrl, "GET", "/v1/admin/relayd-release?channel=stable", adminAuth);
    assert.equal(read.status, 200);
    assert.equal(read.json.release.sha256, descriptor.sha256);
    assert.equal(read.json.release.sig, descriptor.sig);
    assert.equal(read.json.release.sigAlg, "ed25519");
    assert.equal(read.json.release.minVersion, "0.1.0");

    // One row per channel, replaced on publish: this is current state, not a
    // history log.
    const second = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: releaseDescriptor({ version: "0.3.0", notes: "fixes the drain window" }), ...adminAuth,
    });
    assert.equal(second.status, 200);
    const after = await api(t.baseUrl, "GET", "/v1/admin/relayd-release", adminAuth);
    assert.equal(after.json.release.version, "0.3.0");
    assert.equal(after.json.release.notes, "fixes the drain window");
  } finally {
    await t.close();
  }
});

test("a version is canonicalised to one spelling, so the fleet cannot disagree about it", async () => {
  const { t } = await setup();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: releaseDescriptor({ version: " v0.2.0 ", minVersion: "v0.1.0" }), ...adminAuth,
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.release.version, "0.2.0");
    assert.equal(res.json.release.minVersion, "0.1.0");
  } finally {
    await t.close();
  }
});

test("publishing refuses a malformed descriptor field by field, with a code per failure", async () => {
  const { t } = await setup();
  try {
    const cases = [
      ["invalid_channel", { channel: "canary" }],
      ["invalid_channel", { channel: "Stable" }],
      ["invalid_version", { version: "0.2" }],
      ["invalid_version", { version: "0.2.0-rc1" }],
      // A leading zero is a second spelling of a version already spelled
      // "1.2.0"; canonicalising it silently would publish one release under
      // two labels an operator reads as different.
      ["invalid_version", { version: "01.2.0" }],
      ["invalid_min_version", { minVersion: "latest" }],
      // A floor above the release's own version is a release nothing may ever
      // install.
      ["min_version_above_version", { version: "0.2.0", minVersion: "0.3.0" }],
      ["invalid_url", { url: "http://releases.example.com/relayd.tar.gz" }],
      ["invalid_url", { url: "https://user:pw@releases.example.com/relayd.tar.gz" }],
      ["invalid_url", { url: "not a url" }],
      ["invalid_sha256", { sha256: "abc123" }],
      // Uppercase hex is refused rather than folded: the publisher sends
      // digest.hex(), so admitting it only widens what can be stored.
      ["invalid_sha256", { sha256: "A".repeat(64) }],
      ["invalid_sig_alg", { sigAlg: "ed25519-sha512" }],
      ["invalid_sig", { sig: "not-base64url-64-bytes" }],
      // 32 bytes is a key, not an Ed25519 signature.
      ["invalid_sig", { sig: Buffer.alloc(32, 7).toString("base64url") }],
      // Padded, standard-`+/`-alphabet, and non-canonical-final-character
      // spellings all decode to the same 64 bytes and would all verify, which
      // is exactly why only the canonical spelling is stored — the same
      // decode-and-re-encode rule nodeauth.js applies to a request signature.
      // The last one matters most: the final character of an 86-character
      // payload carries four unused bits, so "…AB" and "…AA" are one signature
      // wearing two names.
      ["invalid_sig", { sig: `${Buffer.alloc(64, 1).toString("base64url")}=` }],
      ["invalid_sig", { sig: Buffer.alloc(64, 0xff).toString("base64") }],
      ["invalid_sig", { sig: `${Buffer.alloc(64, 0).toString("base64url").slice(0, 85)}B` }],
      ["invalid_notes", { notes: "one line\nand a forged second" }],
      ["invalid_notes", { notes: "n".repeat(201) }],
      ["invalid_notes", { notes: 42 }],
    ];
    for (const [expected, overrides] of cases) {
      const res = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
        body: releaseDescriptor(overrides), ...adminAuth,
      });
      assert.equal(res.status, 400, `${JSON.stringify(overrides)} must be refused`);
      assert.equal(res.json.error, expected, JSON.stringify(overrides));
    }

    // Nothing was published by any of those, so the poll path is unchanged.
    const read = await api(t.baseUrl, "GET", "/v1/admin/relayd-release?channel=stable", adminAuth);
    assert.equal(read.status, 404);
    assert.equal(read.json.error, "no_release");
  } finally {
    await t.close();
  }
});

test("the release routes stay on ADMIN_TOKEN, and the read route validates its channel", async () => {
  const { t, session } = await setup();
  try {
    const unauthed = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: releaseDescriptor(),
    });
    assert.equal(unauthed.status, 401);
    const withSession = await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: releaseDescriptor(),
      headers: { authorization: `Bearer ${session.sessionToken}` },
    });
    assert.equal(withSession.status, 401, "a session bearer is not ops auth");
    assert.equal(
      (await api(t.baseUrl, "GET", "/v1/admin/relayd-release?channel=canary", adminAuth)).status,
      400,
    );
  } finally {
    await t.close();
  }
});

// ── announcement on the poll ──────────────────────────────────────────────

test("the poll OMITS release entirely until something is published for the channel", async () => {
  const { t, identity } = await setup();
  try {
    const before = await poll(t, identity);
    assert.equal(before.status, 200);
    assert.ok(
      !("release" in before.json),
      "absent, not null: an older relayd ignores an unknown field, a null is something it must special-case",
    );
    // The contracts this rides alongside are untouched.
    assert.deepEqual(before.json.handoffs, []);
    assert.deepEqual(before.json.notices, []);
    assert.equal(before.json.computerAccess.allowed, true);

    const descriptor = releaseDescriptor({ notes: "adopts the releases/ layout" });
    await api(t.baseUrl, "POST", "/v1/admin/relayd-release", { body: descriptor, ...adminAuth });

    const after = await poll(t, identity);
    assert.equal(after.status, 200);
    assert.deepEqual(after.json.release, {
      channel: "stable",
      version: "0.2.0",
      url: descriptor.url,
      sha256: descriptor.sha256,
      sigAlg: "ed25519",
      sig: descriptor.sig,
      minVersion: "0.1.0",
      notes: "adopts the releases/ layout",
    });
    // Ambient state: re-reading it costs nothing and consumes nothing, so a
    // second poll says exactly the same thing. No row, no lease, no ack.
    const again = await poll(t, identity);
    assert.deepEqual(again.json.release, after.json.release);
  } finally {
    await t.close();
  }
});

test("notes is omitted, not null, when a release was published without one", async () => {
  const { t, identity } = await setup();
  try {
    await api(t.baseUrl, "POST", "/v1/admin/relayd-release", { body: releaseDescriptor(), ...adminAuth });
    const res = await poll(t, identity);
    assert.ok(!("notes" in res.json.release));
    assert.equal(res.json.release.version, "0.2.0");
  } finally {
    await t.close();
  }
});

test("a beta machine is offered beta's release, never stable's", async () => {
  const { t, session, identity } = await setup();
  try {
    const betaIdentity = nodeIdentity();
    t.app.registry.createNode(session.accountId, {
      id: BETA_NODE_ID, kind: "byo", name: "beta box", pubkey: betaIdentity.pubkeyPem,
    });
    await heartbeat(t, identity, { body: { channel: "stable", version: "0.1.0" } });
    const betaPath = "/v1/node/heartbeat";
    t.clock.t += 1;
    await api(t.baseUrl, "POST", betaPath, {
      body: { channel: "beta", version: "0.1.0" },
      ...nodeHeaders(betaIdentity, { method: "POST", pathWithQuery: betaPath, ts: t.clock.t, nodeId: BETA_NODE_ID }),
    });

    const stable = releaseDescriptor({ channel: "stable", version: "0.2.0" });
    const beta = releaseDescriptor({ channel: "beta", version: "0.3.0" });
    await api(t.baseUrl, "POST", "/v1/admin/relayd-release", { body: stable, ...adminAuth });
    await api(t.baseUrl, "POST", "/v1/admin/relayd-release", { body: beta, ...adminAuth });

    const onStable = await poll(t, identity);
    assert.equal(onStable.json.release.channel, "stable");
    assert.equal(onStable.json.release.version, "0.2.0");

    const onBeta = await poll(t, betaIdentity, { nodeId: BETA_NODE_ID });
    assert.equal(onBeta.json.release.channel, "beta");
    assert.equal(onBeta.json.release.version, "0.3.0");
    assert.equal(onBeta.json.release.sig, beta.sig);

    // The two machines in play must not move together, which is the entire
    // reason channels exist here: publishing beta must not reach stable.
    assert.notEqual(onStable.json.release.version, onBeta.json.release.version);
  } finally {
    await t.close();
  }
});

test("a node that never reported a channel is on stable", async () => {
  const { t, identity } = await setup();
  try {
    assert.equal(t.app.registry.getNode(NODE_ID).channel, null);
    await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: releaseDescriptor({ channel: "stable" }), ...adminAuth,
    });
    await api(t.baseUrl, "POST", "/v1/admin/relayd-release", {
      body: releaseDescriptor({ channel: "beta", version: "9.9.9" }), ...adminAuth,
    });
    const res = await poll(t, identity);
    assert.equal(res.json.release.channel, "stable");
    assert.equal(res.json.release.version, "0.2.0");
  } finally {
    await t.close();
  }
});

// ── fleet visibility ──────────────────────────────────────────────────────

test("GET /v1/admin/nodes reports channel and pendingVersion, the names the release script reads", async () => {
  const { t, identity } = await setup();
  try {
    await heartbeat(t, identity, {
      body: { version: "0.1.0", channel: "beta", pendingVersion: "0.2.0" },
    });
    const res = await api(t.baseUrl, "GET", "/v1/admin/nodes", adminAuth);
    assert.equal(res.status, 200);
    const node = res.json.nodes.find((entry) => entry.id === NODE_ID);
    assert.equal(node.version, "0.1.0");
    assert.equal(node.channel, "beta");
    assert.equal(node.pendingVersion, "0.2.0");
    // Still no credential-like material on an admin listing.
    assert.equal(node.pubkey, undefined);
  } finally {
    await t.close();
  }
});

// ── migration ─────────────────────────────────────────────────────────────

// Every other test here opens its database through db.js's createDb(), whose
// SCHEMA already declares the new columns — so the ALTER TABLE branch of
// ensureRelaydReleaseSchema never runs in any of them. This builds the
// pre-release-subscription shape directly so that path is exercised, in the
// same spirit as registry-migration.test.mjs.
test("an old-schema database gains the channel columns and the release store on open", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (
      id          TEXT PRIMARY KEY,
      apple_sub   TEXT UNIQUE,
      email       TEXT UNIQUE,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE refresh_tokens (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  INTEGER NOT NULL,
      revoked_at  INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE nodes (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      name        TEXT,
      pubkey      TEXT NOT NULL,
      enc_pubkey  TEXT,
      version     TEXT,
      last_seen   INTEGER,
      created_at  INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run("acct-1", 1000);
  db.prepare(
    "INSERT INTO nodes (id, account_id, kind, name, pubkey, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("node-preexisting", "acct-1", "byo", "old box", "pk-pem", "0.1.0", 1000);

  const registry = createRegistry(db, { now: () => 2000 });

  const node = registry.getNode("node-preexisting");
  assert.equal(node.version, "0.1.0", "the pre-existing row survives");
  assert.equal(node.channel, null);
  assert.equal(node.pendingVersion, null);

  registry.touchNode("node-preexisting", { channel: "beta", pendingVersion: "0.2.0" });
  const touched = registry.getNode("node-preexisting");
  assert.equal(touched.channel, "beta");
  assert.equal(touched.pendingVersion, "0.2.0");
  assert.equal(touched.lastSeen, 2000);

  assert.equal(registry.getRelaydRelease("stable"), null);
  registry.publishRelaydRelease({
    channel: "stable",
    version: "0.2.0",
    url: "https://releases.example.com/relayd/0.2.0/relayd-0.2.0.tar.gz",
    sha256: "a".repeat(64),
    sig: "s".repeat(86),
    sigAlg: "ed25519",
    minVersion: "0.1.0",
    notes: null,
  });
  assert.equal(registry.getRelaydRelease("stable").version, "0.2.0");
  assert.equal(registry.getRelaydRelease("stable").publishedAt, 2000);
  assert.equal(registry.getRelaydRelease("beta"), null);

  // Reopening the same database must not fail re-adding a column or re-creating
  // the table (main.js restarting against the same file).
  assert.doesNotThrow(() => createRegistry(db, { now: () => 3000 }));
  assert.equal(
    db.prepare("PRAGMA table_info(nodes)").all().filter((c) => c.name === "channel").length, 1,
  );
});
