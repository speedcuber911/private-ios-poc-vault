// relayd timeline-claude.mjs — turns Claude Code's messages into timeline events.
// Two sources share one mapping: the live `--output-format stream-json` stream of
// a running job, and the session transcript on disk (thread history).
//
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 1.

// Live. Feed every parsed stream-json line in order; each call returns the
// timeline events (spec 1.1 shapes) that line produces.
export function createClaudeStreamMapper() {
  return {
    push(_line) {
      return [];
    },
    // The final answer text from the `result` line, or "" before it arrives.
    finalAnswer() {
      return "";
    },
  };
}

// History. Feed every parsed transcript line in file order; take() returns the
// complete `step` objects seen since the previous take() and clears them.
export function createClaudeTranscriptCollector() {
  return {
    push(_entry) {},
    take() {
      return [];
    },
  };
}
