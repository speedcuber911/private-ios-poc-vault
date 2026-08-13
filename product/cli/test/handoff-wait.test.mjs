// `relay handoff` watching the handoff through to a terminal state.
//
// The command used to end at "Check your phone — it should be there in a
// moment", which proved only that the CLOUD had accepted a row. The node still
// had to lease it, clone the branch, decrypt the sealed blobs and import the
// session — and a failed import printed the identical cheerful line. `pending`
// is not success; it is what a handoff looks like when nothing collected it,
// which from the desk is indistinguishable from a machine that is powered off.
//
// awaitTerminalState is exercised directly here: cmdHandoff's own setup needs
// a real git repo and a sealed push, which the neighbouring handoff.test.mjs
// already covers, and none of that is what this behaviour is about.
import test from "node:test";
import assert from "node:assert/strict";

import { awaitTerminalState } from "../src/commands/handoff.mjs";

const HANDOFF_ID = "a1b2c3d4e5f60718";
const REPO = "me/relay";

// A clock that only moves when the code under test sleeps. No real time
// passes, so a 120s budget costs nothing to test.
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleepImpl: async (ms) => { t += ms; },
    advance: (ms) => { t += ms; },
  };
}

function listing(rows) {
  return { status: 200, json: { handoffs: rows } };
}

// Responses are consumed one per call; the last one repeats forever.
function apiReturning(...responses) {
  const calls = [];
  return {
    calls,
    listHandoffs: async (repo) => {
      calls.push(repo);
      return responses[Math.min(calls.length - 1, responses.length - 1)];
    },
  };
}

const base = (clock, api) => ({
  api, repo: REPO, handoffId: HANDOFF_ID,
  budgetMs: 120_000, pollIntervalMs: 1500,
  sleepImpl: clock.sleepImpl, now: clock.now,
});

test("resolves as soon as the row reaches ready", async () => {
  const clock = fakeClock();
  const api = apiReturning(
    listing([{ id: HANDOFF_ID, state: "pending" }]),
    listing([{ id: HANDOFF_ID, state: "leased" }]),
    listing([{ id: HANDOFF_ID, state: "delivered" }]),
    listing([{ id: HANDOFF_ID, state: "ready" }]),
  );

  const outcome = await awaitTerminalState(base(clock, api));

  assert.equal(outcome.state, "ready");
  assert.equal(api.calls.length, 4, "it must stop polling the moment it is ready");
});

// `delivered` is written when the node ACKs the lease — before the import runs.
// Treating it as terminal would report success for an import that then failed.
test("delivered is not terminal", async () => {
  const clock = fakeClock();
  const api = apiReturning(listing([{ id: HANDOFF_ID, state: "delivered" }]));

  const outcome = await awaitTerminalState({ ...base(clock, api), budgetMs: 6000 });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.state, "delivered");
});

test("a failed row is terminal and carries its reason", async () => {
  const clock = fakeClock();
  const api = apiReturning(
    listing([{ id: HANDOFF_ID, state: "pending" }]),
    listing([{ id: HANDOFF_ID, state: "failed", reason: "clone_failed" }]),
  );

  const outcome = await awaitTerminalState(base(clock, api));

  assert.equal(outcome.state, "failed");
  assert.equal(outcome.reason, "clone_failed");
});

test("gives up at the budget and reports the last state it saw", async () => {
  const clock = fakeClock();
  const api = apiReturning(listing([{ id: HANDOFF_ID, state: "pending" }]));

  const outcome = await awaitTerminalState({ ...base(clock, api), budgetMs: 9000 });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.state, "pending");
  // 1500ms polls inside a 9000ms budget: it must terminate, and promptly.
  assert.ok(api.calls.length <= 8, `polled ${api.calls.length} times, expected the budget to stop it`);
});

// Someone else's handoff on the same repo must not be mistaken for this one.
test("ignores rows for other handoff ids", async () => {
  const clock = fakeClock();
  const api = apiReturning(listing([{ id: "ffffffffffffffff", state: "ready" }]));

  const outcome = await awaitTerminalState({ ...base(clock, api), budgetMs: 6000 });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.state, "pending", "an unrelated ready row must not be adopted");
});

// The handoff is already recorded by this point. A watch that cannot see it
// must not invent a failure.
test("a throwing listing does not become a handoff failure", async () => {
  const clock = fakeClock();
  let calls = 0;
  const api = {
    listHandoffs: async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return listing([{ id: HANDOFF_ID, state: "ready" }]);
    },
  };

  const outcome = await awaitTerminalState(base(clock, api));

  assert.equal(outcome.state, "ready", "it must recover once the listing works again");
});

test("a non-200 listing is tolerated the same way", async () => {
  const clock = fakeClock();
  const api = apiReturning(
    { status: 502, json: {} },
    listing([{ id: HANDOFF_ID, state: "ready" }]),
  );

  const outcome = await awaitTerminalState(base(clock, api));

  assert.equal(outcome.state, "ready");
});

// A permanently broken listing must still end, rather than spinning forever.
test("a permanently failing listing still terminates at the budget", async () => {
  const clock = fakeClock();
  const api = { listHandoffs: async () => { throw new Error("down"); } };

  const outcome = await awaitTerminalState({ ...base(clock, api), budgetMs: 9000 });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.state, "pending");
});
