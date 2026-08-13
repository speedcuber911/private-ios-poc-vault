import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { signEd25519, verifyEd25519, signHS256 } from "../src/jwt.js";

function pair() {
  return generateKeyPairSync("ed25519");
}

test("signEd25519 / verifyEd25519 round-trip", () => {
  const { publicKey, privateKey } = pair();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signEd25519({ sub: "acct", node: "n1", scope: ["jobs.read"], exp }, privateKey);
  const payload = verifyEd25519(token, publicKey);
  assert.equal(payload.sub, "acct");
  assert.equal(payload.node, "n1");
});

test("verifyEd25519 returns null for HMAC tokens, wrong key, expiry, and junk", () => {
  const { publicKey, privateKey } = pair();
  const other = pair();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const good = signEd25519({ sub: "a", exp }, privateKey);
  assert.equal(verifyEd25519(good, other.publicKey), null);
  assert.equal(verifyEd25519(signHS256({ sub: "a", exp }, "secret-secret-secret-secret-0000"), publicKey), null);
  assert.equal(verifyEd25519(signEd25519({ sub: "a", exp: 1 }, privateKey), publicKey), null);
  assert.equal(verifyEd25519("not-a-jwt", publicKey), null);
  assert.equal(verifyEd25519("", publicKey), null);
});
