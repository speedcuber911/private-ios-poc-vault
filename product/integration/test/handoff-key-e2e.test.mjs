// Cross-product guard: the handoff encryption key survives the round trip
// from a node's identity, through the control plane, to the CLI that seals
// against it.
//
// WHY THIS TEST EXISTS
//
// Removing trial provisioning removed the only writer of `nodes.enc_pubkey`.
// `POST /v1/nodes` had never accepted one, because until then no BYO node had
// ever needed to publish a key — hosted nodes were enrolled by the sandbox
// bootstrap, which set it. Nothing failed loudly when that writer went away:
// the column simply stayed NULL, `relay handoff` sealed to nothing, and the
// break would have surfaced as an empty recipient far from its cause.
//
// The single-product suites could not have caught it. The cloud's own tests
// are satisfied by storing whatever they are handed; relayd's are satisfied by
// generating a keypair it never publishes. Only the seam is wrong, so only a
// test that crosses the seam can see it.
//
// It therefore asserts the whole chain with REAL keys and REAL ciphertext —
// no fixtures — because a fixture is exactly the thing that keeps passing
// after the code that produced it stops being called:
//
//   relayd identity  ->  POST /v1/nodes  ->  GET /v1/nodes  ->  sealTo()
//                                                                  |
//                                                    relayd openSealed()

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-handoff-e2e-"));
process.env.CODEX_DATA_DIR = path.join(root, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(root, "identity");

const { startTestApp, signIn, api, authed } = await import("../../cloud/test/helpers.mjs");
const { initIdentity, identityPaths, readEncPublicKeyB64 } = await import("../../relayd/src/identity.mjs");
const { openSealed } = await import("../../relayd/src/seal.mjs");
const { sealTo: cliSealTo } = await import("../../cli/src/seal.mjs");

test("a BYO node's encryption key reaches the CLI, and only that node can open what the CLI seals", async () => {
  const t = await startTestApp();
  try {
    const account = await signIn(t);
    const identity = initIdentity();
    const paths = identityPaths();
    const pubkeyPem = fs.readFileSync(paths.identityPubPath, "utf8");
    const encPubkey = readEncPublicKeyB64();

    // A real X25519 public key, not a placeholder: the route validates the
    // encoding, so a stand-in would test the validator instead of the seam.
    assert.equal(Buffer.from(encPubkey, "base64").length, 32);

    // 1. The phone registers the machine it just paired with.
    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      ...authed(account.sessionToken),
      body: { id: identity.nodeId, kind: "byo", name: "My VM", pubkey: pubkeyPem, encPubkey },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    // 2. The CLI reads the account's nodes to pick its handoff target. This is
    //    the exact surface `relay login` uses, and the exact one that returned
    //    a null key before the fix.
    const listed = await api(t.baseUrl, "GET", "/v1/nodes", authed(account.sessionToken));
    assert.equal(listed.status, 200);
    const node = listed.json.nodes.find((n) => n.id === identity.nodeId);
    assert.ok(node, "the registered node is missing from the account's node list");
    assert.equal(
      node.encPubkey,
      encPubkey,
      "the control plane must hand back the key the node published, byte for byte",
    );

    // 3. The CLI seals a session to it — its own implementation, not relayd's,
    //    since the two are separate codebases that must stay compatible.
    const plaintext = Buffer.from(JSON.stringify({ v: 1, session: "transcript bytes" }));
    const sealed = cliSealTo(node.encPubkey, plaintext);

    // 4. Only the node can open it. The control plane relayed a public key and
    //    never saw a private one.
    const opened = openSealed(fs.readFileSync(paths.encKeyPath, "utf8"), sealed);
    assert.deepEqual(opened, plaintext);
  } finally {
    await t.close();
  }
});

test("a node registered without an encryption key is usable but cannot receive a handoff", async () => {
  const t = await startTestApp();
  try {
    const account = await signIn(t);
    const { publicKey } = (await import("node:crypto")).generateKeyPairSync("ed25519");
    const pubkeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

    const created = await api(t.baseUrl, "POST", "/v1/nodes", {
      ...authed(account.sessionToken),
      body: { id: "node-0123456789abcdef", kind: "byo", name: "Older daemon", pubkey: pubkeyPem },
    });
    assert.equal(created.status, 201);

    // Null rather than absent or empty string: the CLI branches on this to
    // refuse the handoff up front instead of sealing to nothing, which is the
    // failure mode this whole file exists to prevent.
    const listed = await api(t.baseUrl, "GET", "/v1/nodes", authed(account.sessionToken));
    const node = listed.json.nodes.find((n) => n.id === "node-0123456789abcdef");
    assert.equal(node.encPubkey, null);
  } finally {
    await t.close();
  }
});
