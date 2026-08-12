import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";
import { parseNodePubkey } from "../src/notify.js";
import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";
import {
  verifyNodeRequest,
  nodeRequestSigningInput,
  createReplayGuard,
  NODE_REQUEST_LABEL,
} from "../src/nodeauth.js";

const NODE_ID = "node-00112233445566aa";
const PATH = "/v1/node/handoffs?wait=5";
const TS_MAX_AGE_MS = 10 * 60 * 1000;

function setup() {
  const clock = { t: 1_800_000_000_000 };
  const registry = createRegistry(createDb(":memory:"), { now: () => clock.t });
  const account = registry.createAccount({ appleSub: "apple-1", email: "a@example.com" });
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubkeyPem = publicKey.export({ type: "spki", format: "pem" });
  registry.createNode(account.id, { id: NODE_ID, kind: "trial", name: "Trial", pubkey: pubkeyPem });
  return { clock, registry, account, privateKey, pubkeyPem };
}

// Every call site must now decide about replay explicitly (T7-I3): a route
// that supplies neither a guard nor `allowReplay` fails closed. Tests that
// are not about replay opt out, exactly as a proven side-effect-free route
// would.
function verify(req, { registry, clock, pathWithQuery = PATH, ...rest }) {
  const options = { registry, now: () => clock.t, ...rest };
  if (!options.replayGuard && options.allowReplay === undefined) options.allowReplay = true;
  return verifyNodeRequest(req, pathWithQuery, options);
}

function signedRequest({
  privateKey, method = "GET", pathWithQuery = PATH, ts, nodeId = NODE_ID,
  // The four fields below let a test sign one tuple and PRESENT another, which
  // is the only way to prove a field is actually bound into the signed bytes.
  signTs = ts, signNodeId = nodeId, signMethod = method, signPathWithQuery = pathWithQuery,
  tsHeader, encodeSignature = (sig) => sig.toString("base64url"),
}) {
  const signature = crypto.sign(
    null,
    nodeRequestSigningInput({ method: signMethod, pathWithQuery: signPathWithQuery, ts: signTs, nodeId: signNodeId }),
    privateKey,
  );
  return {
    method,
    headers: {
      "x-relay-node": nodeId,
      "x-relay-ts": tsHeader ?? String(ts),
      "x-relay-signature": encodeSignature(signature),
    },
  };
}

test("a correctly signed request resolves to its node", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  assert.equal(verify(req, { registry, clock }).node.id, NODE_ID);
});

test("a signature bound to a different path or method is refused", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });

  assert.equal(verify(req, { registry, clock, pathWithQuery: "/v1/node/handoffs?wait=25" }).error, "bad_signature");
  assert.equal(verify({ ...req, method: "POST" }, { registry, clock }).error, "bad_signature");
});

// N7 in the task-7 review's mutation table: nothing proved the timestamp was
// bound into the signed bytes. If it were ever dropped from the canonical
// string, one captured signature would authenticate under ANY fresh in-window
// ts — defeating the freshness window and the replay guard (whose key
// includes ts) in a single stroke. Sign one ts, present another.
test("the timestamp is bound into the signature, not merely carried beside it", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t, signTs: clock.t - 1000 });
  assert.equal(verify(req, { registry, clock }).error, "bad_signature");
});

// N6: the node id is bound into the signed bytes. Registering a SECOND node
// that carries the first node's public key is what makes this observable —
// the signature then verifies under either node's stored key, so only the
// node id inside the canonical string can distinguish them.
test("the node id is bound into the signature, so one node's signature cannot speak for another", () => {
  const { clock, registry, account, privateKey, pubkeyPem } = setup();
  const twinId = "node-ffffffffffffffff";
  registry.createNode(account.id, { id: twinId, kind: "trial", name: "Twin", pubkey: pubkeyPem });

  const req = signedRequest({ privateKey, ts: clock.t, nodeId: twinId, signNodeId: NODE_ID });
  assert.equal(verify(req, { registry, clock }).error, "bad_signature");
  // Control: the same twin signing for itself is accepted, so the refusal
  // above is the node-id binding and not the twin being unusable.
  assert.equal(verify(signedRequest({ privateKey, ts: clock.t, nodeId: twinId }), { registry, clock }).node.id, twinId);
});

// N8: the protocol label is the domain separator between this canonical
// string and the raw-body signing /v1/node-events uses. Without it the two
// signing domains overlap and a signature minted for one is usable in the
// other.
test("the protocol label is bound into the signature", () => {
  const { clock, registry, privateKey } = setup();
  const unlabelled = Buffer.from(`GET\n${PATH}\n${NODE_ID}\n${clock.t}`, "utf8");
  const req = {
    method: "GET",
    headers: {
      "x-relay-node": NODE_ID,
      "x-relay-ts": String(clock.t),
      "x-relay-signature": crypto.sign(null, unlabelled, privateKey).toString("base64url"),
    },
  };
  assert.equal(verify(req, { registry, clock }).error, "bad_signature");
  assert.ok(NODE_REQUEST_LABEL.length > 0);
});

test("stale and future timestamps are refused", () => {
  const { clock, registry, privateKey } = setup();
  const stale = signedRequest({ privateKey, ts: clock.t - 11 * 60 * 1000 });
  const future = signedRequest({ privateKey, ts: clock.t + 3 * 60 * 1000 });
  assert.equal(verify(stale, { registry, clock }).error, "bad_ts");
  assert.equal(verify(future, { registry, clock }).error, "bad_ts");
});

// N9: with the safe-integer check removed, `Number.parseInt("abc")` is NaN,
// every NaN comparison in the window check is false, and the request sails
// past the freshness gate to fail later as a bad signature. Asserting the
// EXACT error is what makes that mutation visible.
test("a non-numeric timestamp is refused as a bad timestamp, not as a bad signature", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t, tsHeader: "abc" });
  assert.equal(verify(req, { registry, clock }).error, "bad_ts");
});

// T7-M2: `Number.parseInt` accepts leading whitespace, a leading `+`, leading
// zeros, an exponent and arbitrary trailing junk — eight spellings of one
// timestamp, all authenticating under one signature. relayd sends
// String(Date.now()), so requiring the canonical spelling costs nothing.
test("only the canonical spelling of a timestamp is accepted", () => {
  const { clock, registry, privateKey } = setup();
  const ts = clock.t;
  for (const tsHeader of [` ${ts}`, `+${ts}`, `${ts}abc`, `${ts}.0`, `${ts} `, `0${ts}`, `${ts}e0`]) {
    const req = signedRequest({ privateKey, ts, tsHeader });
    assert.equal(verify(req, { registry, clock }).error, "bad_ts", `non-canonical ts accepted: ${JSON.stringify(tsHeader)}`);
  }
  assert.equal(verify(signedRequest({ privateKey, ts }), { registry, clock }).node.id, NODE_ID);
});

test("another node's key cannot sign for this node", () => {
  const { clock, registry } = setup();
  const stranger = crypto.generateKeyPairSync("ed25519").privateKey;
  const req = signedRequest({ privateKey: stranger, ts: clock.t });
  assert.equal(verify(req, { registry, clock }).error, "bad_signature");
});

// N18: `missing_signature` must require ALL THREE headers. A mutant that
// checks only the node id lets a header-less request reach the crypto path.
test("every one of the three headers is required", () => {
  const { clock, registry, privateKey } = setup();
  const full = signedRequest({ privateKey, ts: clock.t });
  for (const missing of ["x-relay-node", "x-relay-ts", "x-relay-signature"]) {
    const headers = { ...full.headers };
    delete headers[missing];
    assert.equal(verify({ method: "GET", headers }, { registry, clock }).error, "missing_signature",
      `a request without ${missing} was not reported as missing_signature`);
  }
  assert.equal(verify({ method: "GET", headers: {} }, { registry, clock }).error, "missing_signature");
});

test("unknown nodes are reported distinctly", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t, nodeId: "node-ffffffffffffffff" });
  assert.equal(verify(req, { registry, clock }).error, "unknown_node");
});

// N11: the node-key-unusable branch is load-bearing. Removing it does not
// merely change an error string — `cryptoVerify` throws on a null key, so the
// route returns 500 {"error":"internal"} instead of a clean 401, and the
// throw is an oracle that the other four failure paths are not.
test("a node whose stored pubkey cannot be parsed fails closed without throwing", () => {
  const { clock, registry, account, privateKey } = setup();
  const brokenId = "node-badbadbadbadbad0";
  registry.createNode(account.id, { id: brokenId, kind: "trial", name: "Broken", pubkey: "not-a-key" });

  const req = signedRequest({ privateKey, ts: clock.t, nodeId: brokenId });
  let result;
  assert.doesNotThrow(() => { result = verify(req, { registry, clock }); });
  assert.equal(result.error, "node_key_unusable");
  assert.equal(result.node, undefined);
});

// ── T7-I2: keys that authenticate without a private key ───────────────────
//
// For the ed25519 identity point A, the pair (R = A, S = 0) verifies against
// ANY message: the verification equation collapses to A = A. The same holds
// for the rest of the order-dividing-8 subgroup. OpenSSL does not refuse
// these on import, so a node registered with one is an auth boundary that
// hands back {node} for a request nobody signed — and a node whose key
// material is zeroed or corrupted to such a value fails OPEN.
//
// libsodium's ed25519_small_order() blacklist is the reference list; relayd's
// seal.mjs refuses the X25519 analogue (a non-canonical or all-zero recipient
// key), and these two key types travel together on the same node row, so they
// must agree.
const ED25519_SMALL_ORDER_HEX = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
];

test("parseNodePubkey refuses low-order and identity ed25519 points", () => {
  for (const hex of ED25519_SMALL_ORDER_HEX) {
    const raw = Buffer.from(hex, "hex");
    assert.equal(parseNodePubkey(raw.toString("base64")), null, `raw small-order key accepted: ${hex}`);

    // The sign bit does not change a point's order, so the high-bit variant
    // of each blacklisted encoding must be refused too.
    const flipped = Buffer.from(raw);
    flipped[31] |= 0x80;
    assert.equal(parseNodePubkey(flipped.toString("base64")), null, `sign-bit variant accepted: ${hex}`);
  }
  // A real key still parses — the blacklist must not be a blanket refusal.
  const good = crypto.generateKeyPairSync("ed25519").publicKey;
  assert.notEqual(parseNodePubkey(good.export({ type: "spki", format: "pem" }).toString()), null);
});

test("parseNodePubkey refuses a low-order point presented as SPKI PEM", () => {
  const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
  const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
  const pem = crypto
    .createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, identity]), format: "der", type: "spki" })
    .export({ type: "spki", format: "pem" })
    .toString();
  assert.ok(pem.includes("BEGIN PUBLIC KEY"));
  assert.equal(parseNodePubkey(pem), null);
});

test("a signature built with no private key at all cannot authenticate", () => {
  const { clock, registry, account } = setup();
  const identity = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
  const forgedId = "node-000000000000dead";
  registry.createNode(account.id, { id: forgedId, kind: "trial", name: "Forged", pubkey: identity.toString("base64") });

  // R = A, S = 0. No private key was used to build this.
  const forged = Buffer.concat([identity, Buffer.alloc(32)]);
  const req = {
    method: "GET",
    headers: {
      "x-relay-node": forgedId,
      "x-relay-ts": String(clock.t),
      "x-relay-signature": forged.toString("base64url"),
    },
  };
  const result = verify(req, { registry, clock });
  assert.equal(result.node, undefined, "a keyless signature authenticated");
  assert.equal(result.error, "node_key_unusable");
});

// ── replay ────────────────────────────────────────────────────────────────

test("a replay guard allows the first use of a signature and rejects an identical replay", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  const req = signedRequest({ privateKey, ts: clock.t });

  assert.equal(verify(req, { registry, clock, replayGuard: guard }).node.id, NODE_ID);
  assert.equal(verify(req, { registry, clock, replayGuard: guard }).error, "replayed");
});

// T7-C1 REGRESSION. `Buffer.from(s, "base64url")` is lenient: it accepts the
// standard `+/` alphabet, accepts padding, silently skips every non-alphabet
// character, and ignores the four unused bits in the final character of an
// 86-character payload. Keying the guard on the header STRING therefore
// guarded nothing — each spelling below replayed successfully and
// permanently consumed handoffs minted after the capture.
test("a captured signature cannot be replayed by re-spelling its base64", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  const ts = clock.t;
  const signature = crypto.sign(
    null, nodeRequestSigningInput({ method: "GET", pathWithQuery: PATH, ts, nodeId: NODE_ID }), privateKey,
  );
  const canonical = signature.toString("base64url");
  const hdr = (s) => ({ method: "GET", headers: { "x-relay-node": NODE_ID, "x-relay-ts": String(ts), "x-relay-signature": s } });

  assert.equal(verify(hdr(canonical), { registry, clock, replayGuard: guard }).node.id, NODE_ID);

  const respellings = {
    stdBase64: signature.toString("base64"),
    stdBase64Stripped: signature.toString("base64").replace(/=+$/, ""),
    trailingEquals: `${canonical}=`,
    trailingEqualsEquals: `${canonical}==`,
    embeddedSpace: `${canonical.slice(0, 10)} ${canonical.slice(10)}`,
    embeddedNewline: `${canonical.slice(0, 10)}\n${canonical.slice(10)}`,
    embeddedBang: `${canonical.slice(0, 10)}!${canonical.slice(10)}`,
    trailingJunk: `${canonical}!!!`,
  };
  for (const [name, spelling] of Object.entries(respellings)) {
    assert.equal(
      Buffer.from(spelling, "base64url").equals(signature), true,
      `${name} is not a re-spelling of the same signature bytes — the test premise is wrong`,
    );
    const result = verify(hdr(spelling), { registry, clock, replayGuard: guard });
    assert.equal(result.node, undefined, `replay accepted under spelling ${name}`);
    assert.equal(result.error, "bad_signature", `spelling ${name} should be refused as non-canonical`);
  }
});

// The second layer of the T7-C1 fix, tested where the canonicality check
// cannot mask it: even handed two different SPELLINGS of one signature, the
// guard must see one entry, because it keys on the decoded bytes.
test("the replay guard keys on decoded signature bytes, not on the header spelling", () => {
  const guard = createReplayGuard();
  const now = 1_800_000_000_000;
  const sig = crypto.randomBytes(64);
  const identity = (signature) => ({ method: "GET", pathWithQuery: PATH, nodeId: NODE_ID, ts: now, signature });

  assert.equal(guard.claim(identity(sig), now), true);
  assert.equal(guard.claim(identity(Buffer.from(sig.toString("base64"), "base64url")), now), false);
  assert.equal(guard.claim(identity(Buffer.from(`${sig.toString("base64url")}=`, "base64url")), now), false);
  assert.equal(guard.claim(identity(Buffer.from(sig)), now), false);
});

// N14/N15/N16: every component of the cache key was removable without a test
// noticing — the blind spot that let T7-C1 through. Each assertion below
// dies if its field is dropped from the key.
test("the replay guard's key is composed of every field of the request identity", () => {
  const now = 1_800_000_000_000;
  const base = { method: "GET", pathWithQuery: PATH, nodeId: NODE_ID, ts: now, signature: crypto.randomBytes(64) };
  const fresh = () => {
    const guard = createReplayGuard();
    assert.equal(guard.claim(base, now), true);
    return guard;
  };

  assert.equal(fresh().claim({ ...base, signature: crypto.randomBytes(64) }, now), true, "signature is not in the key");
  assert.equal(fresh().claim({ ...base, ts: now + 1 }, now), true, "ts is not in the key");
  assert.equal(fresh().claim({ ...base, nodeId: "node-ffffffffffffffff" }, now), true, "nodeId is not in the key");
  assert.equal(fresh().claim({ ...base, pathWithQuery: "/v1/node/handoffs?wait=6" }, now), true, "pathWithQuery is not in the key");
  assert.equal(fresh().claim({ ...base, method: "POST" }, now), true, "method is not in the key");
  assert.equal(fresh().claim({ ...base }, now), false, "an identical identity was not recognised as a replay");
});

// The key must not be forgeable by running two fields together. The two
// identities below are DIFFERENT requests whose fields concatenate to the
// same bytes, so a key built without length prefixes (or any other
// unambiguous framing) collides and the second is refused as a replay.
test("the replay guard's key cannot be collided by shifting a field boundary", () => {
  const guard = createReplayGuard();
  const now = 1_800_000_000_000;
  const signature = crypto.randomBytes(64);
  const a = { method: "GET", pathWithQuery: "/a", nodeId: "bc", ts: now, signature };
  const b = { method: "GET", pathWithQuery: "/ab", nodeId: "c", ts: now, signature };
  assert.equal(
    `${a.pathWithQuery}${a.nodeId}`, `${b.pathWithQuery}${b.nodeId}`,
    "the two identities no longer concatenate alike — the test premise is wrong",
  );
  assert.equal(guard.claim(a, now), true);
  assert.equal(guard.claim(b, now), true, "two distinct requests collided into one cache entry");
});

// The T7-C1 fix has two layers — reject non-canonical spellings, and key the
// guard on decoded bytes — and the first masks the second from any test that
// goes through the HTTP surface. This pins the contract between them
// directly: whatever verifyNodeRequest hands the guard must be the decoded
// signature, so the guard stays correct even if the canonicality check is
// ever relaxed.
test("the replay guard is handed the decoded signature bytes, not the header string", () => {
  const { clock, registry, privateKey } = setup();
  const claimed = [];
  const spy = { claim(identity) { claimed.push(identity); return true; } };
  const req = signedRequest({ privateKey, ts: clock.t });

  assert.equal(verify(req, { registry, clock, replayGuard: spy }).node.id, NODE_ID);
  assert.equal(claimed.length, 1);
  const identity = claimed[0];
  assert.ok(Buffer.isBuffer(identity.signature), "the guard was handed a string, not decoded bytes");
  assert.deepEqual(identity.signature, Buffer.from(req.headers["x-relay-signature"], "base64url"));
  assert.equal(identity.nodeId, NODE_ID);
  assert.equal(identity.ts, clock.t);
  assert.equal(identity.method, "GET");
  assert.equal(identity.pathWithQuery, PATH);
});

// T7-I1. The freshness window admits `ts` while `ts >= now - TS_MAX_AGE_MS`,
// i.e. up to and INCLUDING now === ts + TS_MAX_AGE_MS. An entry that expired
// at exactly that instant left one millisecond in which the timestamp was
// still fresh and the guard had already forgotten it.
test("a replay at exactly the edge of the freshness window is still refused", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  const ts = clock.t;
  const req = signedRequest({ privateKey, ts });

  assert.equal(verify(req, { registry, clock, replayGuard: guard }).node.id, NODE_ID);

  clock.t = ts + TS_MAX_AGE_MS;
  assert.equal(verify(req, { registry, clock, replayGuard: guard }).error, "replayed",
    "a replay succeeded at exactly ts + TS_MAX_AGE_MS");

  clock.t = ts + TS_MAX_AGE_MS + 1;
  assert.equal(verify(req, { registry, clock, replayGuard: guard }).error, "bad_ts",
    "past the window the timestamp itself must be refused");
});

test("a different ts, and therefore a different signature, is not a replay", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  assert.equal(verify(signedRequest({ privateKey, ts: clock.t }), { registry, clock, replayGuard: guard }).node.id, NODE_ID);
  assert.equal(verify(signedRequest({ privateKey, ts: clock.t + 1 }), { registry, clock, replayGuard: guard }).node.id, NODE_ID);
});

// T7-I3: replay defence is the DEFAULT. The handoff long-poll looked like a
// read — a GET named /handoffs — and was in fact permanently consuming, so
// "a replayed read is harmless" is not a judgement a future route author
// should have to make correctly by omission. A call site that says nothing
// gets no authentication at all.
test("a call site that supplies neither a guard nor an opt-out fails closed", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  const result = verifyNodeRequest(req, PATH, { registry, now: () => clock.t });
  assert.equal(result.node, undefined, "a route with no replay defence authenticated a request");
  assert.equal(result.error, "replay_guard_missing");
});

// T7-M5: the options object carried a `= {}` default that made `registry` and
// `now` look optional, and turned a would-be ReferenceError at the call site
// into a throw halfway through verification.
test("a miswired call site fails immediately and by name", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  assert.throws(() => verifyNodeRequest(req, PATH), { name: "TypeError" });
  assert.throws(() => verifyNodeRequest(req, PATH, {}),
    { name: "TypeError", message: "verifyNodeRequest requires { registry, now }" });
  assert.throws(() => verifyNodeRequest(req, PATH, { registry }),
    { name: "TypeError", message: "verifyNodeRequest requires { registry, now }" });
  assert.throws(() => verifyNodeRequest(req, PATH, { now: () => clock.t }),
    { name: "TypeError", message: "verifyNodeRequest requires { registry, now }" });
});

test("allowReplay is an explicit opt-out for routes proven side-effect-free", () => {
  const { clock, registry, privateKey } = setup();
  const req = signedRequest({ privateKey, ts: clock.t });
  const opts = { registry, now: () => clock.t, allowReplay: true };
  assert.equal(verifyNodeRequest(req, PATH, opts).node.id, NODE_ID);
  assert.equal(verifyNodeRequest(req, PATH, opts).node.id, NODE_ID);
});

// N13: nothing may be returned to the caller before the guard has run.
test("a replayed request never yields a node", () => {
  const { clock, registry, privateKey } = setup();
  const guard = createReplayGuard();
  const req = signedRequest({ privateKey, ts: clock.t });
  verify(req, { registry, clock, replayGuard: guard });
  const replay = verify(req, { registry, clock, replayGuard: guard });
  assert.equal(replay.node, undefined);
});

// ── end to end, over the wired route ──────────────────────────────────────
//
// The unit tests above constrain nodeauth.js. These two constrain the thing
// that actually shipped: the handoff long-poll, which is a GET that
// permanently consumes rows.

test("a re-spelled signature cannot steal handoffs from the node long-poll", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const identity = makeNodeIdentity();
    await api(t.baseUrl, "POST", "/v1/repos", { body: { fullName: "o/r" }, ...authed(session.sessionToken) });
    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "n", pubkey: identity.pubkeyPem }, ...authed(session.sessionToken),
    });
    const nodeId = created.json.node.id;

    const pathWithQuery = "/v1/node/handoffs?wait=0";
    const ts = t.clock.t;
    const signature = crypto.sign(
      null, nodeRequestSigningInput({ method: "GET", pathWithQuery, ts, nodeId }), identity.privateKey,
    );
    const canonical = signature.toString("base64url");
    const poll = (spelling) => api(t.baseUrl, "GET", pathWithQuery, {
      headers: { "x-relay-node": nodeId, "x-relay-ts": String(ts), "x-relay-signature": spelling },
    });
    let minted = 0;
    const mintHandoff = (branch) => api(t.baseUrl, "POST", "/v1/handoffs", {
      body: { handoffId: String(++minted).padStart(16, "a"), nodeId, repo: "o/r", branch },
      ...authed(session.sessionToken),
    });

    await mintHandoff("relay/handoff-first");
    const legitimate = await poll(canonical);
    assert.equal(legitimate.status, 200);
    assert.equal(legitimate.json.handoffs.length, 1);

    assert.equal((await poll(canonical)).status, 401, "a byte-identical replay was accepted");

    // Handoffs minted AFTER the capture. Each replay spelling must take none
    // of them, and must leave every one still pending for the real node.
    for (const [name, spelling] of Object.entries({
      stdBase64: signature.toString("base64"),
      trailingPad: `${canonical}=`,
      embeddedSpace: `${canonical.slice(0, 10)} ${canonical.slice(10)}`,
      trailingJunk: `${canonical}!!!`,
    })) {
      await mintHandoff(`relay/handoff-target-${name}`);
      const stolen = await poll(spelling);
      assert.equal(stolen.status, 401, `replay accepted under spelling ${name}`);
      assert.equal(stolen.json.handoffs, undefined);
      assert.deepEqual(stolen.json, { error: "unauthorized" });
    }

    // Everything minted after the capture is still there for the real node.
    // A fresh ts (which relayd mints per call) means a fresh signature, so
    // this is a new claim rather than a replay of the captured one.
    t.clock.t += 1;
    const fresh = t.clock.t;
    const freshSig = crypto.sign(
      null, nodeRequestSigningInput({ method: "GET", pathWithQuery, ts: fresh, nodeId }), identity.privateKey,
    );
    const recovered = await api(t.baseUrl, "GET", pathWithQuery, {
      headers: { "x-relay-node": nodeId, "x-relay-ts": String(fresh), "x-relay-signature": freshSig.toString("base64url") },
    });
    assert.equal(recovered.status, 200);
    assert.equal(recovered.json.handoffs.length, 4, "replays consumed handoffs the real node never received");
  } finally { await t.close(); }
});

test("a node cannot be registered with a key that authenticates without a private key", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    for (const hex of ED25519_SMALL_ORDER_HEX) {
      const res = await api(t.baseUrl, "POST", "/v1/nodes", {
        body: { kind: "byo", name: "evil", pubkey: Buffer.from(hex, "hex").toString("base64") },
        ...authed(session.sessionToken),
      });
      assert.equal(res.status, 400, `POST /v1/nodes accepted a small-order pubkey: ${hex}`);
      assert.equal(res.json.error, "invalid_pubkey");
    }

    // A real node key is still accepted, so the refusals above are the
    // blacklist and not a broken route.
    const good = await api(t.baseUrl, "POST", "/v1/nodes", {
      body: { kind: "byo", name: "ok", pubkey: makeNodeIdentity().pubkeyPem }, ...authed(session.sessionToken),
    });
    assert.equal(good.status, 201);
  } finally { await t.close(); }
});
