// relayd seal.mjs — sealed blobs for the handoff pipeline.
//
// A sealed blob can be produced by anyone holding the recipient's X25519 public
// key and opened only by the holder of the matching private key. Handoff
// manifests and session transcripts are sealed on the laptop before they are
// committed to a git branch, so GitHub only ever stores ciphertext.
//
// CANONICAL COPY. product/cli/src/seal.mjs is a byte-identical vendored copy;
// product/cli/test/seal-vendor.test.mjs fails if the two files diverge.
import crypto from "node:crypto";

const SEAL_MAGIC = Buffer.from("RLYSEAL1", "utf8");
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");
const EPH_PUBLIC_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = SEAL_MAGIC.length + EPH_PUBLIC_BYTES + NONCE_BYTES;
const KDF_INFO_LABEL = Buffer.from("relay-seal-v1", "utf8");

function rawToPublicKey(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== EPH_PUBLIC_BYTES) {
    throw new Error("seal_bad_public_key");
  }
  return crypto.createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function publicKeyToRaw(keyObject) {
  return keyObject.export({ type: "spki", format: "der" }).subarray(X25519_SPKI_PREFIX.length);
}

function deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw) {
  const info = Buffer.concat([KDF_INFO_LABEL, ephemeralPublicRaw, recipientPublicRaw]);
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, SEAL_MAGIC, info, 32));
}

function generateEncKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    publicKeyB64: publicKeyToRaw(publicKey).toString("base64"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

function sealTo(recipientPublicB64, plaintext) {
  const recipientPublicRaw = Buffer.from(String(recipientPublicB64), "base64");
  const recipientPublicKey = rawToPublicKey(recipientPublicRaw);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralPublicRaw = publicKeyToRaw(ephemeral.publicKey);

  const sharedSecret = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientPublicKey,
  });
  const key = deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([SEAL_MAGIC, ephemeralPublicRaw, nonce, ciphertext, cipher.getAuthTag()]);
}

function openSealed(privateKeyPem, sealed) {
  if (!Buffer.isBuffer(sealed) || sealed.length < SEAL_MAGIC.length ||
      !sealed.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC)) {
    throw new Error("seal_bad_magic");
  }
  if (sealed.length < HEADER_BYTES + TAG_BYTES) throw new Error("seal_truncated");

  const ephemeralPublicRaw = sealed.subarray(SEAL_MAGIC.length, SEAL_MAGIC.length + EPH_PUBLIC_BYTES);
  const nonce = sealed.subarray(SEAL_MAGIC.length + EPH_PUBLIC_BYTES, HEADER_BYTES);
  const ciphertext = sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);

  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const recipientPublicRaw = publicKeyToRaw(crypto.createPublicKey(privateKey));

  try {
    const sharedSecret = crypto.diffieHellman({
      privateKey,
      publicKey: rawToPublicKey(Buffer.from(ephemeralPublicRaw)),
    });
    const key = deriveKey(sharedSecret, ephemeralPublicRaw, recipientPublicRaw);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("seal_decrypt_failed");
  }
}

export { SEAL_MAGIC, generateEncKeyPair, sealTo, openSealed };
