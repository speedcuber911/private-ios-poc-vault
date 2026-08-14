import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";

function freshRegistry(clock = { t: 1_000_000 }) {
  const db = createDb(":memory:");
  return { registry: createRegistry(db, { now: () => clock.t }), clock, db };
}

test("trial rows: create, one-per-account read, token lookup, patch", () => {
  const { registry, clock } = freshRegistry();
  const acct = registry.createAccount({ email: "t@example.com" });
  const row = registry.createTrialNode({ accountId: acct.id, enrollTokenHash: "h1", expiresAt: clock.t + 1000 });
  assert.equal(row.state, "creating");
  assert.equal(row.accountId, acct.id);
  assert.equal(row.nodeId, null);
  assert.equal(registry.getTrialByAccount(acct.id).id, row.id);
  assert.equal(registry.getTrialByTokenHash("h1").id, row.id);
  assert.equal(registry.getTrialByTokenHash("nope"), null);

  const patched = registry.updateTrial(row.id, { state: "ready", nodeId: "node-aabbccdd00112233", sandboxId: "sbx_1", enrollTokenHash: null });
  assert.equal(patched.state, "ready");
  assert.equal(patched.nodeId, "node-aabbccdd00112233");
  assert.equal(patched.enrollTokenHash, null);
  // Second trial for the same account must violate the UNIQUE(account_id).
  assert.throws(() => registry.createTrialNode({ accountId: acct.id, enrollTokenHash: "h2", expiresAt: clock.t + 1000 }));
});

test("due/grace scans and active count", () => {
  const { registry, clock } = freshRegistry();
  const a1 = registry.createAccount({ email: "a1@example.com" });
  const a2 = registry.createAccount({ email: "a2@example.com" });
  const r1 = registry.createTrialNode({ accountId: a1.id, enrollTokenHash: "h1", expiresAt: clock.t + 100 });
  const r2 = registry.createTrialNode({ accountId: a2.id, enrollTokenHash: "h2", expiresAt: clock.t + 5000 });
  registry.updateTrial(r1.id, { state: "ready" });
  assert.equal(registry.countActiveTrials(), 2);

  clock.t += 200; // r1 past expiry, r2 not
  const due = registry.listTrialsDue(clock.t);
  assert.deepEqual(due.map((r) => r.id), [r1.id]);

  registry.updateTrial(r1.id, { state: "expired" });
  assert.equal(registry.countActiveTrials(), 1);
  assert.equal(registry.listTrialsPastGrace(clock.t, 1000).length, 0);
  clock.t += 2000;
  assert.deepEqual(registry.listTrialsPastGrace(clock.t, 1000).map((r) => r.id), [r1.id]);
});

test("createNode accepts an explicit id and keeps generating ids otherwise", () => {
  const { registry } = freshRegistry();
  const acct = registry.createAccount({ email: "n@example.com" });
  const explicit = registry.createNode(acct.id, { id: "node-0123456789abcdef", kind: "trial", name: "Trial machine", pubkey: "pk", version: null });
  assert.equal(explicit.id, "node-0123456789abcdef");
  const generated = registry.createNode(acct.id, { kind: "byo", name: null, pubkey: "pk2", version: null });
  assert.match(generated.id, /^[0-9a-f-]{36}$/);
});

test("upgradeTrialAccount converts a live trial and skips upgraded rows in due/active scans", () => {
  const { registry, clock } = freshRegistry();
  const acct = registry.createAccount({ email: "u@example.com" });
  registry.setEntitlement(acct.id, "nodes.max", "1");
  const trial = registry.createTrialNode({
    accountId: acct.id,
    enrollTokenHash: "h",
    expiresAt: clock.t + 100,
  });
  registry.createNode(acct.id, {
    id: "node-0123456789abcdef",
    kind: "trial",
    name: "Trial machine",
    pubkey: "pk",
    version: null,
  });
  registry.updateTrial(trial.id, {
    state: "ready",
    nodeId: "node-0123456789abcdef",
    sandboxId: "sbx_keep",
  });

  assert.equal(registry.upgradeTrialAccount("missing").error, "unknown_account");
  const result = registry.upgradeTrialAccount(acct.id);
  assert.equal(result.ok, true);
  assert.equal(registry.getNode("node-0123456789abcdef").kind, "byo");
  assert.equal(registry.getNode("node-0123456789abcdef").name, "Machine");
  const upgraded = registry.getTrialByAccount(acct.id);
  assert.equal(upgraded.state, "upgraded");
  assert.equal(upgraded.sandboxId, "sbx_keep");
  assert.equal(registry.getEntitlement(acct.id, "nodes.max"), "2");

  const again = registry.upgradeTrialAccount(acct.id);
  assert.equal(again.ok, true);

  clock.t += 10_000;
  assert.equal(registry.listTrialsDue(clock.t).length, 0);
  assert.equal(registry.countActiveTrials(), 0);

  const empty = registry.createAccount({ email: "n@example.com" });
  assert.equal(registry.upgradeTrialAccount(empty.id).error, "nothing_to_upgrade");
});

test("deleteAccount removes trial rows", () => {
  const { registry, clock } = freshRegistry();
  const acct = registry.createAccount({ email: "d@example.com" });
  registry.createTrialNode({ accountId: acct.id, enrollTokenHash: "h", expiresAt: clock.t + 10 });
  assert.equal(registry.deleteAccount(acct.id), true);
  assert.equal(registry.getTrialByAccount(acct.id), null);
});
