import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-idenc-data-"));

const { initIdentity, identityPaths, readEncPublicKeyB64, readEncPrivateKeyPem, identityStatus } =
  await import("../src/identity.mjs");
const { sealTo, openSealed } = await import("../src/seal.mjs");

function freshBase() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relayd-idenc-"));
}

test("initIdentity creates an X25519 encryption keypair alongside the ed25519 identity", () => {
  const baseDir = freshBase();
  initIdentity({ baseDir });
  const paths = identityPaths(baseDir);

  assert.ok(fs.existsSync(paths.encKeyPath), "private encryption key exists");
  assert.ok(fs.existsSync(paths.encPubPath), "public encryption key exists");
  assert.equal(fs.statSync(paths.encKeyPath).mode & 0o777, 0o600, "private key is 0600");
  assert.equal(Buffer.from(readEncPublicKeyB64(paths), "base64").length, 32);
  assert.equal(identityStatus({ baseDir }).hasEncKey, true);
});

test("the published public key opens blobs sealed to it", () => {
  const baseDir = freshBase();
  initIdentity({ baseDir });
  const paths = identityPaths(baseDir);
  const plaintext = Buffer.from("handoff manifest", "utf8");

  const sealed = sealTo(readEncPublicKeyB64(paths), plaintext);

  assert.deepEqual(openSealed(readEncPrivateKeyPem(paths), sealed), plaintext);
});

test("initIdentity is idempotent — a second call keeps the same encryption key", () => {
  const baseDir = freshBase();
  initIdentity({ baseDir });
  const first = readEncPublicKeyB64(identityPaths(baseDir));
  initIdentity({ baseDir });
  assert.equal(readEncPublicKeyB64(identityPaths(baseDir)), first);
});

test("readers return null when no identity has been initialised", () => {
  const paths = identityPaths(freshBase());
  assert.equal(readEncPublicKeyB64(paths), null);
  assert.equal(readEncPrivateKeyPem(paths), null);
});
