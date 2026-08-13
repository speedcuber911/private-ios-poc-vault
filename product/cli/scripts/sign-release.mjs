#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [, , archivePath, signaturePath = `${archivePath || ""}.sig`] = process.argv;
if (!archivePath) {
  console.error("Usage: sign-release.mjs <release-archive> [signature-output]");
  process.exit(2);
}

function readPrivateKey() {
  const encoded = process.env.RELAY_CLI_SIGNING_KEY_B64;
  if (encoded) {
    const decoded = Buffer.from(encoded, "base64");
    if (decoded.length === 0) throw new Error("RELAY_CLI_SIGNING_KEY_B64 is empty or malformed");
    return decoded;
  }

  const configuredPath = process.env.RELAY_CLI_SIGNING_KEY_FILE;
  const defaultPath = path.join(os.homedir(), ".poc-vault", "secrets", "signing", "relay-cli-ed25519.key");
  return fs.readFileSync(configuredPath || defaultPath);
}

const privateKey = crypto.createPrivateKey(readPrivateKey());
if (privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("Relay CLI releases require an Ed25519 private key");
}

const archive = fs.readFileSync(archivePath);
const signature = crypto.sign(null, archive, privateKey);
if (signature.length !== 64) throw new Error("Unexpected Ed25519 signature length");

fs.writeFileSync(signaturePath, `${signature.toString("base64")}\n`, { mode: 0o644 });
console.log(signaturePath);
