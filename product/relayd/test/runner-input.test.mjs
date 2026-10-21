import assert from "node:assert/strict";
import { test } from "node:test";
import { RunnerInputQueue } from "../src/runner-input.mjs";

function fixture(overrides = {}) {
  const calls = [], events = [];
  const queue = new RunnerInputQueue({
    start: async (m) => calls.push(["start", m.id]),
    steer: async (m) => calls.push(["steer", m.id]),
    finish: () => calls.push(["finish"]), notify: (e) => events.push(e), ...overrides,
  });
  return { queue, calls, events };
}

test("follow-ups wait for completion, and promotion steers the same message exactly once", async () => {
  const { queue, calls } = fixture();
  await queue.activate();
  await queue.receive({ id: "one", text: "First", mode: "queue" });
  await queue.receive({ id: "two", text: "Second", mode: "queue" });
  assert.deepEqual(calls, []);
  await queue.receive({ id: "two", text: "Second", mode: "now" });
  await queue.receive({ id: "two", text: "Second", mode: "now" });
  assert.deepEqual(calls, [["steer", "two"]]);
  await queue.turnFinished();
  assert.deepEqual(calls, [["steer", "two"], ["start", "one"]]);
  await queue.turnFinished();
  assert.deepEqual(calls.at(-1), ["finish"]);
});

test("early steering waits for a native turn, and rejected delivery is never called sent", async () => {
  const { queue, calls, events } = fixture({ steer: async () => { throw new Error("turn changed"); } });
  await queue.receive({ id: "one", text: "First", mode: "now" });
  assert.deepEqual(calls, []);
  await queue.activate();
  assert.equal(events.at(-1).status, "failed");
  assert.equal(events.at(-1).error, "turn changed");
  assert.equal(events.some((e) => e.status === "sent"), false);
});

test("a completion race rejects late input instead of silently dropping or replaying it", async () => {
  const { queue, calls, events } = fixture();
  await queue.activate();
  await queue.turnFinished();
  await queue.receive({ id: "late", text: "Late", mode: "now" });
  assert.deepEqual(calls, [["finish"]]);
  assert.equal(events.at(-1).status, "failed");
});
