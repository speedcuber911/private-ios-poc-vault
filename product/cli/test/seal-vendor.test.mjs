import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

test("the vendored seal module is byte-identical to relayd's canonical copy", () => {
  const vendored = fs.readFileSync(path.join(here, "..", "src", "seal.mjs"));
  const canonical = fs.readFileSync(path.join(here, "..", "..", "relayd", "src", "seal.mjs"));
  assert.ok(vendored.equals(canonical),
    "product/cli/src/seal.mjs has drifted from product/relayd/src/seal.mjs — copy the canonical file over");
});

test("the vendored module still seals and opens", async () => {
  const { generateEncKeyPair, sealTo, openSealed } = await import("../src/seal.mjs");
  const recipient = generateEncKeyPair();
  const sealed = sealTo(recipient.publicKeyB64, Buffer.from("vendored", "utf8"));
  assert.equal(openSealed(recipient.privateKeyPem, sealed).toString("utf8"), "vendored");
});
