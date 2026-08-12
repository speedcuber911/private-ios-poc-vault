// Step progress for long-running commands.
//
// `relay handoff` does its slowest work — sealing, git plumbing, and a push to
// GitHub that can take tens of seconds on a large repo — without printing
// anything at all, so the command reads as hung. Every command here makes at
// least one network call, so this is shared rather than special-cased in the
// one that hurt most.
//
// Three decisions worth knowing:
//
// 1. This writes to STDERR, never stdout. Progress is not output. `relay
//    status` is a list someone may pipe, and a spinner interleaved into that
//    stream corrupts it. Same reason npm, cargo and git put progress on
//    stderr.
//
// 2. It is deliberately NOT routed through the `log` dependency each command
//    takes. Tests inject `log` to capture and assert on final output; animation
//    frames landing in those assertions would make them fragile, and the
//    no-op default here means a test that does not care sees nothing.
//
// 3. Without a TTY it degrades to one plain line per step instead of going
//    silent. A CI log or a `2>file` redirect should still show which step ran
//    and, if the command died, which step it died on.

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const HIDE_CURSOR = "\x1B[?25l";
const SHOW_CURSOR = "\x1B[?25h";
const CLEAR_LINE = "\r\x1B[2K";

function createProgress({
  stream = process.stderr,
  isTty = Boolean(stream?.isTTY),
  intervalMs = 80,
  // Seams so the animation can be driven deterministically in tests rather
  // than by waiting on a real clock.
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  onSignal = (name, handler) => process.on(name, handler),
  offSignal = (name, handler) => process.off(name, handler),
  exit = (code) => process.exit(code),
} = {}) {
  let timer = null;
  let label = null;
  let frame = 0;
  let sigintHandler = null;

  function paint() {
    stream.write(`${CLEAR_LINE}  ${FRAMES[frame % FRAMES.length]} ${label}`);
    frame += 1;
  }

  // Ctrl-C during an animation would otherwise leave the user's terminal with
  // a hidden cursor for the rest of the session — the process is gone, so
  // nothing else can put it back. Handling the signal means we own the exit:
  // 130 is the conventional 128+SIGINT, matching what the shell would have
  // reported had we not intercepted it.
  function installSigintGuard() {
    if (sigintHandler) return;
    sigintHandler = () => {
      stop();
      exit(130);
    };
    onSignal("SIGINT", sigintHandler);
  }

  function removeSigintGuard() {
    if (!sigintHandler) return;
    offSignal("SIGINT", sigintHandler);
    sigintHandler = null;
  }

  function start(nextLabel) {
    stop();
    label = String(nextLabel);
    if (!isTty) {
      stream.write(`  ${label}…\n`);
      return;
    }
    frame = 0;
    installSigintGuard();
    stream.write(HIDE_CURSOR);
    paint();
    timer = setIntervalImpl(paint, intervalMs);
    // A progress animation must never be the reason the process stays alive.
    timer?.unref?.();
  }

  function stop() {
    if (timer) {
      clearIntervalImpl(timer);
      timer = null;
    }
    // Guard on `label`, not on `timer`: a non-TTY step has no timer but must
    // still clear its state, and stop() is called unconditionally in finally
    // blocks where no step may have started at all.
    if (label !== null && isTty) {
      stream.write(`${CLEAR_LINE}${SHOW_CURSOR}`);
    }
    label = null;
    removeSigintGuard();
  }

  // The wrapper the call sites use. The finally is the point: a step that
  // throws must not leave a half-drawn line and a hidden cursor behind, and
  // every command here has failure paths that throw straight past the caller.
  async function run(stepLabel, fn) {
    start(stepLabel);
    try {
      return await fn();
    } finally {
      stop();
    }
  }

  return { start, stop, run, get active() { return label; } };
}

// The default for command dependency lists: does nothing, costs nothing, and
// keeps tests that never opt in completely quiet.
const noopProgress = {
  start() {},
  stop() {},
  async run(_label, fn) { return fn(); },
  active: null,
};

export { createProgress, noopProgress, FRAMES };
