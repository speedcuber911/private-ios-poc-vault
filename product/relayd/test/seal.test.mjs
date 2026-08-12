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
  assert.throws(() => openSealed(stranger.privateKeyPem, sealed),
    (e) => e.message === "seal_decrypt_failed" && e.cause instanceof Error);
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
  const sealed = Buffer.from(SEALED_HEX, "hex");
  // Guard the fixture itself: a truncated or corrupted hex literal above
  // must fail loudly right here, as an obvious fixture problem, instead of
  // surfacing later as a confusing decrypt failure that looks like a crypto
  // regression.
  assert.equal(sealed.length, 101, "known-answer fixture must decode to exactly 101 bytes");
  assert.ok(sealed.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC),
    "known-answer fixture must start with the seal magic");

  assert.equal(openSealed(RECIP_PEM, sealed).toString("utf8"),
    "relay handoff known-answer vector");
});

test("sealed length is exactly magic+eph+nonce+plaintext+tag", () => {
  const r = generateEncKeyPair();
  assert.equal(sealTo(r.publicKeyB64, Buffer.alloc(40)).length, 8 + 32 + 12 + 40 + 16);
});

test("a malformed or wrong-type private key is rejected before touching the sealed bytes", () => {
  const recipient = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("secret", "utf8"));

  assert.throws(() => openSealed("not a pem at all", sealed),
    (e) => e.message === "seal_bad_private_key" && e.cause instanceof Error);
  assert.throws(() => openSealed("", sealed),
    (e) => e.message === "seal_bad_private_key" && e.cause instanceof Error);

  const { privateKey: ed25519Key } = crypto.generateKeyPairSync("ed25519");
  const ed25519Pem = ed25519Key.export({ type: "pkcs8", format: "pem" });
  assert.throws(() => openSealed(ed25519Pem, sealed), /seal_bad_private_key/);
});

test("a Uint8Array view of a valid blob opens correctly", () => {
  const recipient = generateEncKeyPair();
  const plaintext = Buffer.from("view me", "utf8");
  const sealed = sealTo(recipient.publicKeyB64, plaintext);
  // Build the view at a non-zero byteOffset into a larger backing buffer so
  // this test cannot pass by accident: normalizing with something like
  // Buffer.from(input.buffer) (dropping byteOffset/byteLength) would read
  // from the start of `backing` instead of the sealed slice and fail.
  const backing = new Uint8Array(7 + sealed.length);
  backing.set(sealed, 7);
  const view = new Uint8Array(backing.buffer, 7, sealed.length);
  assert.deepEqual(openSealed(recipient.privateKeyPem, view), plaintext);
});

test("a genuine non-buffer input is rejected as seal_bad_input", () => {
  const recipient = generateEncKeyPair();
  assert.throws(() => openSealed(recipient.privateKeyPem, "not a buffer"), /seal_bad_input/);
  assert.throws(() => openSealed(recipient.privateKeyPem, null), /seal_bad_input/);
});

// Fixed fixture (not randomly generated) so it deterministically contains
// both "+" and "/": a randomly generated key has a measured ~27% chance of
// containing neither, which would silently turn the url-safe variant below
// into a no-op.
const CANONICAL_PUBLIC_KEY_B64 = "D0+e1jCPrC5UvQ+oMWuxPa8VbAoDPFGm7qFK/wYUKQE=";

test("sealTo requires the canonical base64 encoding of the recipient public key", () => {
  const raw = Buffer.from(CANONICAL_PUBLIC_KEY_B64, "base64");
  assert.equal(raw.length, 32);

  const urlSafe = CANONICAL_PUBLIC_KEY_B64.replace(/\+/g, "-").replace(/\//g, "_");
  const whitespace = `${CANONICAL_PUBLIC_KEY_B64}\n`;
  const invalidChar = `!${CANONICAL_PUBLIC_KEY_B64.slice(1)}`;
  // The trailing pre-"=" character encodes 4 real data bits followed by 2
  // padding bits that a canonical encoder always sets to zero. Bumping that
  // character to the next one in its 4-character alphabet group flips only
  // the (discarded) padding bits, so it decodes to the exact same 32 bytes
  // while being a different, non-canonical string — a regex character-class
  // check (e.g. /^[A-Za-z0-9+/]{43}=$/) would wrongly accept it; only a real
  // encode/decode round-trip catches it.
  const aliasedTrailingChar = "D0+e1jCPrC5UvQ+oMWuxPa8VbAoDPFGm7qFK/wYUKQF=";
  assert.notEqual(aliasedTrailingChar, CANONICAL_PUBLIC_KEY_B64);
  assert.deepEqual(Buffer.from(aliasedTrailingChar, "base64"), raw,
    "the aliased encoding must decode to the identical 32 bytes");

  for (const variant of [urlSafe, whitespace, invalidChar, aliasedTrailingChar]) {
    assert.throws(() => sealTo(variant, Buffer.from("x")), /seal_bad_public_key/,
      `non-canonical encoding must be rejected: ${JSON.stringify(variant)}`);
  }

  // sanity check the url-safe variant actually still decodes to the same 32
  // bytes, otherwise the loop above would be pinning the wrong thing
  assert.equal(Buffer.from(urlSafe.replace(/-/g, "+").replace(/_/g, "/"), "base64").length, 32);
});
