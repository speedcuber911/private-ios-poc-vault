// relayd timeline-codex.mjs — turns Codex's items into timeline events.
// Two sources share one mapping: app-server notifications from a running job,
// and the session rollout on disk (thread history).
//
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 1.

// Live. Feed every app-server notification ({ method, params }) in order; each
// call returns the timeline events (spec 1.1 shapes) that notification produces.
export function createCodexNotificationMapper() {
  return {
    push(_notification) {
      return [];
    },
  };
}

// History. Feed every parsed rollout line in file order; take() returns the
// complete `step` objects seen since the previous take() and clears them.
export function createCodexTranscriptCollector() {
  return {
    push(_entry) {},
    take() {
      return [];
    },
  };
}
