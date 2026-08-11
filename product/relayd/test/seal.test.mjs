import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { generateEncKeyPair, sealTo, openSealed, SEAL_MAGIC } = await import("../src/seal.mjs");

test("seal round-trips a payload the recipient can open", () => {
  const recipient = generateEncKeyPair();
  const plaintext = Buffer.from(JSON.stringify({ hello: "world", n: 42 }), "utf8");

  const sealed = sealTo(recipient.publicKeyB64, plaintext);

  assert.ok(sealed.subarray(0, 8).equals(SEAL_MAGIC), "sealed blob starts with the magic");
  assert.ok(!sealed.includes(Buffer.from("hello", "utf8")), "plaintext must not survive in the blob");
  assert.deepEqual(openSealed(recipient.privateKeyPem, sealed), plaintext);
});

test("seal is non-deterministic — each call uses a fresh ephemeral key", () => {
  const recipient = generateEncKeyPair();
  const plaintext = Buffer.from("same input", "utf8");
  const a = sealTo(recipient.publicKeyB64, plaintext);
  const b = sealTo(recipient.publicKeyB64, plaintext);
  assert.notDeepEqual(a, b, "two seals of the same plaintext must differ");
  assert.deepEqual(openSealed(recipient.privateKeyPem, a), plaintext);
  assert.deepEqual(openSealed(recipient.privateKeyPem, b), plaintext);
});

test("the wrong recipient cannot open a sealed blob", () => {
  const recipient = generateEncKeyPair();
  const stranger = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("secret", "utf8"));
  assert.throws(() => openSealed(stranger.privateKeyPem, sealed), /seal_decrypt_failed/);
});

test("tampering with any byte of the blob is detected", () => {
  const recipient = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("secret payload", "utf8"));
  for (const index of [8, 40, 55, sealed.length - 1]) {
    const tampered = Buffer.from(sealed);
    tampered[index] ^= 0x01;
    assert.throws(() => openSealed(recipient.privateKeyPem, tampered), /seal_decrypt_failed/,
      `flipping byte ${index} must be rejected`);
  }
});

test("a blob without the magic or shorter than the header is rejected", () => {
  const recipient = generateEncKeyPair();
  assert.throws(() => openSealed(recipient.privateKeyPem, Buffer.alloc(80)), /seal_bad_magic/);
  assert.throws(() => openSealed(recipient.privateKeyPem, Buffer.concat([SEAL_MAGIC, Buffer.alloc(4)])),
    /seal_truncated/);
});

test("public keys are 32 raw bytes in base64 and private keys are PKCS#8 PEM", () => {
  const pair = generateEncKeyPair();
  assert.equal(Buffer.from(pair.publicKeyB64, "base64").length, 32);
  assert.match(pair.privateKeyPem, /^-----BEGIN PRIVATE KEY-----/);
  assert.equal(crypto.createPrivateKey(pair.privateKeyPem).asymmetricKeyType, "x25519");
});
