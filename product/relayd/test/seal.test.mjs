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
  assert.notEqual(a.subarray(8, 40).toString("hex"), b.subarray(8, 40).toString("hex"),
    "each seal must carry a fresh ephemeral public key");
  assert.notEqual(a.subarray(40, 52).toString("hex"), b.subarray(40, 52).toString("hex"),
    "each seal must carry a fresh nonce");
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

// This vector freezes the wire format (magic || ephemeral pubkey || nonce ||
// ciphertext || tag) and the exact HKDF derivation (salt = SEAL_MAGIC, info =
// label || ephemeral pubkey || recipient pubkey). It was generated once
// against a known-correct implementation and must never be regenerated to
// make a failing test pass — doing so would silently validate a wire-format
// or KDF change that breaks every blob already sealed and committed under
// the old format.
const RECIP_PEM = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VuBCIEIBERERERERERERERERERERERERERERERERERERERERER\n-----END PRIVATE KEY-----\n";
const SEALED_HEX = "524c595345414c310faa684ed28867b97f4a6a2dee5df8ce974e76b7018e3f22a1c4cf2678570f2033333333333333333333333315e6f96ff6516ef5f9864d7e33bd639339573d6da63608b07ac57634214debf19e9826dd3a28164f583736b7d8b9c62d22";

test("known-answer vector pins the wire format and the KDF", () => {
  assert.equal(openSealed(RECIP_PEM, Buffer.from(SEALED_HEX, "hex")).toString("utf8"),
    "relay handoff known-answer vector");
});

test("sealed length is exactly magic+eph+nonce+plaintext+tag", () => {
  const r = generateEncKeyPair();
  assert.equal(sealTo(r.publicKeyB64, Buffer.alloc(40)).length, 8 + 32 + 12 + 40 + 16);
});

test("a malformed or wrong-type private key is rejected before touching the sealed bytes", () => {
  const recipient = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("secret", "utf8"));

  assert.throws(() => openSealed("not a pem at all", sealed), /seal_bad_private_key/);
  assert.throws(() => openSealed("", sealed), /seal_bad_private_key/);

  const { privateKey: ed25519Key } = crypto.generateKeyPairSync("ed25519");
  const ed25519Pem = ed25519Key.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => openSealed(ed25519Pem, sealed), /seal_bad_private_key/);
});

test("a Uint8Array view of a valid blob opens correctly", () => {
  const recipient = generateEncKeyPair();
  const plaintext = Buffer.from("view me", "utf8");
  const sealed = sealTo(recipient.publicKeyB64, plaintext);
  const view = new Uint8Array(sealed);
  assert.deepEqual(openSealed(recipient.privateKeyPem, view), plaintext);
});

test("a genuine non-buffer input is rejected as seal_bad_input", () => {
  const recipient = generateEncKeyPair();
  assert.throws(() => openSealed(recipient.privateKeyPem, "not a buffer"), /seal_bad_input/);
  assert.throws(() => openSealed(recipient.privateKeyPem, null), /seal_bad_input/);
});

test("sealTo requires the canonical base64 encoding of the recipient public key", () => {
  const recipient = generateEncKeyPair();
  const raw = Buffer.from(recipient.publicKeyB64, "base64");

  const urlSafe = recipient.publicKeyB64.replace(/\+/g, "-").replace(/\//g, "_");
  const whitespace = `${recipient.publicKeyB64}\n`;
  const invalidChar = `!${recipient.publicKeyB64.slice(1)}`;

  for (const variant of [urlSafe, whitespace, invalidChar]) {
    if (variant === recipient.publicKeyB64) continue;
    assert.throws(() => sealTo(variant, Buffer.from("x")), /seal_bad_public_key/,
      `non-canonical encoding must be rejected: ${JSON.stringify(variant)}`);
  }

  // sanity check the fixture actually still decodes to the same 32 bytes,
  // otherwise the test above would be pinning the wrong thing
  assert.equal(Buffer.from(urlSafe.replace(/-/g, "+").replace(/_/g, "/"), "base64").length, 32);
  assert.equal(raw.length, 32);
});
