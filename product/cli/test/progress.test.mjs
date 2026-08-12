import test from "node:test";
import assert from "node:assert/strict";

const { createProgress, noopProgress, FRAMES } = await import("../src/progress.mjs");

const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";

// A stream that records everything written, plus a hand-driven interval so the
// animation advances on command instead of on a real clock.
function harness({ isTty = true } = {}) {
  const writes = [];
  const timers = [];
  let nextId = 1;
  const signals = new Map();
  const exits = [];

  const progress = createProgress({
    stream: { write: (chunk) => writes.push(chunk), isTTY: isTty },
    isTty,
    setIntervalImpl: (fn) => {
      const timer = { id: nextId++, fn, cleared: false, unrefCalls: 0, unref() { this.unrefCalls += 1; return this; } };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => {
      if (timer) timer.cleared = true;
    },
    onSignal: (name, handler) => signals.set(name, handler),
    offSignal: (name) => signals.delete(name),
    exit: (code) => exits.push(code),
  });

  return {
    progress,
    writes,
    timers,
    exits,
    signals,
    output: () => writes.join(""),
    tick: () => timers.filter((t) => !t.cleared).forEach((t) => t.fn()),
  };
}

test("on a TTY a step hides the cursor and paints a frame", () => {
  const h = harness();
  h.progress.start("Pushing to GitHub");

  assert.ok(h.output().startsWith(HIDE_CURSOR), "the cursor must be hidden before the first paint");
  assert.match(h.output(), /Pushing to GitHub/);
  assert.ok(h.output().includes(FRAMES[0]), "the first spinner frame must be painted immediately, not one interval later");
});

test("the animation advances through frames", () => {
  const h = harness();
  h.progress.start("Sealing");
  h.tick();
  h.tick();

  assert.ok(h.output().includes(FRAMES[1]) && h.output().includes(FRAMES[2]),
    "successive ticks must paint successive frames");
});

test("stopping clears the line and restores the cursor", () => {
  const h = harness();
  h.progress.start("Sealing");
  h.progress.stop();

  assert.ok(h.output().endsWith(SHOW_CURSOR), "the cursor must be visible again once the step ends");
  assert.equal(h.timers[0].cleared, true, "the interval must be cleared, or it keeps painting over later output");
});

// A progress animation that holds the event loop open turns a finished command
// into a hung one.
test("the interval is unref'd so it cannot keep the process alive", () => {
  const h = harness();
  h.progress.start("Sealing");
  assert.equal(h.timers[0].unrefCalls, 1);
});

test("starting a second step stops the first", () => {
  const h = harness();
  h.progress.start("First");
  h.progress.start("Second");

  assert.equal(h.timers.length, 2);
  assert.equal(h.timers[0].cleared, true, "the first step's interval must not survive the second step");
  assert.equal(h.timers[1].cleared, false);
});

// Without a TTY the frames would be meaningless control characters in a log
// file, but going silent loses which step a failure happened on.
test("without a TTY each step prints one plain line and no ANSI", () => {
  const h = harness({ isTty: false });
  h.progress.start("Pushing to GitHub");
  h.progress.stop();

  assert.equal(h.output(), "  Pushing to GitHub…\n");
  assert.equal(h.timers.length, 0, "no animation should be scheduled without a TTY");
  assert.doesNotMatch(h.output(), /\x1B\[/, "no escape sequences may reach a non-TTY stream");
});

test("run returns the step's value and leaves nothing running", async () => {
  const h = harness();
  const value = await h.progress.run("Sealing", async () => "sealed");

  assert.equal(value, "sealed");
  assert.equal(h.progress.active, null);
  assert.equal(h.timers[0].cleared, true);
});

// The failure path is the one that matters: every command here throws past its
// caller, and a throw mid-animation would otherwise leave the terminal with a
// half-drawn line and no cursor for the rest of the session.
test("run stops the animation and restores the cursor when the step throws", async () => {
  const h = harness();
  const boom = new Error("push_failed");

  const thrown = await h.progress.run("Pushing", async () => {
    throw boom;
  }).then(() => null, (err) => err);

  assert.equal(thrown, boom, "run must not swallow the error");
  assert.equal(h.progress.active, null);
  assert.equal(h.timers[0].cleared, true);
  assert.ok(h.output().endsWith(SHOW_CURSOR), "the cursor must be restored even when the step throws");
});

// Ctrl-C during a spinner would otherwise leave the cursor hidden for the rest
// of the terminal session — the process is gone and cannot put it back.
test("SIGINT restores the cursor and exits 130", () => {
  const h = harness();
  h.progress.start("Pushing");

  const handler = h.signals.get("SIGINT");
  assert.ok(handler, "a SIGINT guard must be installed while a step is active");
  handler();

  assert.ok(h.output().endsWith(SHOW_CURSOR), "the cursor must be restored before exiting");
  assert.deepEqual(h.exits, [130], "128+SIGINT is what the shell would have reported");
});

test("the SIGINT guard is removed once the step ends", () => {
  const h = harness();
  h.progress.start("Pushing");
  h.progress.stop();

  assert.equal(h.signals.get("SIGINT"), undefined,
    "leaving the guard installed would swallow Ctrl-C for the rest of the command");
});

test("stop is safe when no step ever started", () => {
  const h = harness();
  h.progress.stop();
  assert.equal(h.output(), "");
});

test("the no-op progress runs the step and stays silent", async () => {
  assert.equal(await noopProgress.run("anything", async () => 42), 42);
  assert.equal(noopProgress.active, null);
});
