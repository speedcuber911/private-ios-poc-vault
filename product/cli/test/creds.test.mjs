import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { readCredentials, writeCredentials, clearCredentials } = await import("../src/creds.mjs");

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-home-"));
}

test("credentials round-trip and are private to the user", () => {
  const home = freshHome();
  writeCredentials({ sessionToken: "s", refreshToken: "r", accountId: "acct", nodeId: "node-1", nodeEncPubkey: "k" }, { home });

  assert.deepEqual(readCredentials({ home }), {
    sessionToken: "s", refreshToken: "r", accountId: "acct", nodeId: "node-1", nodeEncPubkey: "k",
  });
  assert.equal(fs.statSync(path.join(home, ".relay", "credentials.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(home, ".relay")).mode & 0o777, 0o700);
});

test("writing merges into what is already stored", () => {
  const home = freshHome();
  writeCredentials({ sessionToken: "s", accountId: "acct" }, { home });
  writeCredentials({ nodeId: "node-2" }, { home });

  const stored = readCredentials({ home });
  assert.equal(stored.sessionToken, "s");
  assert.equal(stored.nodeId, "node-2");
});

test("reading with nothing stored, or after clearing, returns null", () => {
  const home = freshHome();
  assert.equal(readCredentials({ home }), null);
  writeCredentials({ sessionToken: "s" }, { home });
  clearCredentials({ home });
  assert.equal(readCredentials({ home }), null);
});
