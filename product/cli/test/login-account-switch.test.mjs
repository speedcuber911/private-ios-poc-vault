// `relay login` when the machine is already signed in as someone else.
//
// Reported from real use: a CLI was signed in and pinned to its owner's
// sandbox, `relay login` was run again, and a SECOND PERSON scanned the QR and
// approved it with THEIR account.
//
// The server side is sound — approval is a one-shot atomic bind, so a code
// already bound to any account is refused. The defect was entirely in the CLI:
// writeCredentials merges by design, login wrote only session/refresh/accountId,
// and the only thing that overwrote the machine pin was the trial lookup — which
// returns early when the new account has no machine. The result was one
// credentials file holding account B's session next to account A's `nodeId` and
// `nodeEncPubkey`.
//
// That mismatch is not cosmetic:
//   - `relay handoff` seals the session blob to the pinned node's public key and
//     pushes it to GitHub BEFORE the cloud rejects the row as `unknown_node` —
//     content encrypted to another account's key, published to a remote.
//   - `relay sync-auth` sends this machine's GitHub and harness logins to
//     whichever sandbox is pinned.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cmdLogin } from "../src/commands/login.mjs";
import { readCredentials, writeCredentials } from "../src/creds.mjs";

const OTHER_NODE = "node-00112233445566aa";
const OTHER_KEY = `${"a".repeat(43)}=`;
const KOMAL_NODE = "node-99887766554433bb";
const KOMAL_KEY = `${"b".repeat(43)}=`;

function fakeCloud({ accountId, trial }) {
  return async (url, options = {}) => {
    const { pathname } = new URL(url);
    if (pathname === "/v1/auth/device/start") {
      return {
        status: 201,
        json: async () => ({
          deviceCode: "dc", userCode: "ABCD-EFGH",
          verificationUri: "https://relay.test/cli-login",
          verificationUriComplete: "https://relay.test/cli-login#code=ABCD-EFGH",
          interval: 5, expiresIn: 900,
        }),
      };
    }
    if (pathname === "/v1/auth/device/token") {
      return {
        status: 200,
        json: async () => ({ sessionToken: "sess2", refreshToken: "ref2", accountId, expiresIn: 900 }),
      };
    }
    if (pathname === "/v1/trial-nodes/current") {
      return trial
        ? { status: 200, json: async () => ({ trial }) }
        : { status: 404, json: async () => ({ error: "no_trial" }) };
    }
    return { status: 500, json: async () => ({ error: "not_part_of_this_test" }) };
  };
}

// Signed in as "owner", pinned to owner's machine.
function homeSignedInAsOwner() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-switch-"));
  writeCredentials({
    sessionToken: "sess1", refreshToken: "ref1", accountId: "owner",
    nodeId: OTHER_NODE, nodeEncPubkey: OTHER_KEY,
  }, { home });
  return home;
}

const run = (home, fetchImpl, lines) => cmdLogin([], {
  home, baseUrl: "https://cloud.test", fetchImpl,
  log: (line) => lines.push(line), sleep: async () => {},
  stdout: { isTTY: false, columns: 80 },
});

// THE BUG. Komal approves; Komal has no machine, so the trial lookup returns
// early — and before the fix, the owner's pin was still sitting there.
test("a different account approving must not inherit the previous machine pin", async () => {
  const home = homeSignedInAsOwner();
  const lines = [];

  await run(home, fakeCloud({ accountId: "komal", trial: null }), lines);

  const stored = readCredentials({ home });
  assert.equal(stored.accountId, "komal", "the new account's session is stored");
  assert.equal(stored.nodeId, null, "the previous account's machine must be unpinned");
  assert.equal(stored.nodeEncPubkey, null, "and so must its encryption key");
});

test("the account switch is stated, not silent", async () => {
  const home = homeSignedInAsOwner();
  const lines = [];

  await run(home, fakeCloud({ accountId: "komal", trial: null }), lines);

  const output = lines.join("\n");
  assert.match(output, /DIFFERENT account/, "the operator must be told the account changed");
  assert.match(output, /unpinned/, "and that the machine pin was dropped");
  assert.match(output, /sync-auth/, "and warned what would have leaked");
});

// The switch must be reported even when the new account DOES have a machine —
// that is the more dangerous case, because everything still appears to work.
test("switching to an account that has its own machine still warns, and repins", async () => {
  const home = homeSignedInAsOwner();
  const lines = [];

  await run(home, fakeCloud({
    accountId: "komal",
    trial: { id: "t2", state: "ready", nodeId: KOMAL_NODE, nodeEncPubkey: KOMAL_KEY, sni: "k.tun.test", createdAt: 1, expiresAt: 2 },
  }), lines);

  const stored = readCredentials({ home });
  assert.equal(stored.nodeId, KOMAL_NODE, "the new account's machine is pinned");
  assert.equal(stored.nodeEncPubkey, KOMAL_KEY);
  assert.match(lines.join("\n"), /DIFFERENT account/);
});

// Re-logging into the SAME account is the ordinary case and must stay quiet.
test("logging in again as the same account does not warn", async () => {
  const home = homeSignedInAsOwner();
  const lines = [];

  await run(home, fakeCloud({
    accountId: "owner",
    trial: { id: "t1", state: "ready", nodeId: OTHER_NODE, nodeEncPubkey: OTHER_KEY, sni: "o.tun.test", createdAt: 1, expiresAt: 2 },
  }), lines);

  const output = lines.join("\n");
  assert.doesNotMatch(output, /DIFFERENT account/);
  assert.match(output, /Signed in\./);
  assert.equal(readCredentials({ home }).nodeId, OTHER_NODE);
});

// A stale pin is wrong even within one account: the machine it named is gone.
test("same account whose machine has since gone away is unpinned, not left stale", async () => {
  const home = homeSignedInAsOwner();
  const lines = [];

  await run(home, fakeCloud({ accountId: "owner", trial: null }), lines);

  const stored = readCredentials({ home });
  assert.equal(stored.accountId, "owner");
  assert.equal(stored.nodeId, null, "a machine that no longer exists must not stay pinned");
  assert.equal(stored.nodeEncPubkey, null);
});

// First-ever login has no previous account, so there is nothing to warn about.
test("a first login on a clean machine does not warn", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-fresh-"));
  const lines = [];

  await run(home, fakeCloud({ accountId: "owner", trial: null }), lines);

  assert.doesNotMatch(lines.join("\n"), /DIFFERENT account/);
  assert.equal(readCredentials({ home }).accountId, "owner");
});

test("no secret from either account is ever printed", async () => {
  const home = homeSignedInAsOwner();
  const lines = [];

  await run(home, fakeCloud({ accountId: "komal", trial: null }), lines);

  const output = lines.join("\n");
  for (const secret of ["sess1", "sess2", "ref1", "ref2", "dc"]) {
    assert.ok(!output.includes(secret), `${secret} must never be printed`);
  }
});
