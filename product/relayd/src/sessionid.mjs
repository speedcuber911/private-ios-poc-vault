// relayd sessionid.mjs — THE definition of what a resumable session id is.
//
// WHY THIS FILE EXISTS. This one value crosses four module boundaries that
// used to disagree about its shape, and the disagreement broke Continue for
// every Codex handoff, 100% of the time:
//
//   1. the CLI derives it (`cli/src/sessions.mjs`),
//   2. `sessionimport.mjs` turns it into a filename inside the jail,
//   3. `threads.cleanOptionalSessionId` gates it on the way into `createJob`,
//   4. `threads.readSessionMeta` re-checks the id a staged rollout declares.
//
// (2) used to accept `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` while (3) accepted
// `^[a-f0-9-]{36}$` — 100 characters apart in permissiveness, on opposite
// sides of a module boundary, with nothing reconciling them. So a Codex
// rollout id was happily STAGED and then rejected 400 `resumeSessionId is
// invalid` the instant the user pressed Continue: staged successfully,
// unusable forever.
//
// THE CONTRACT, decided rather than widened: a resumable imported session id
// is the lowercase UUID-shaped token emitted by Codex and Claude. Kimi Code
// emits an opaque bounded id, so its wider shape is defined separately and is
// never accepted by the handoff import path:
//
//   - Claude Code names its transcript `<uuid>.jsonl`;
//   - Codex records `payload.id` in the rollout's `session_meta` line as a
//     UUID (the rollout FILENAME carries a timestamp prefix as well — that
//     filename fragment is not the id, and treating it as one is the bug);
//   - `cursor-agent` reports `session_id` as a UUID (`adapters/cursor.mjs`
//     already validates it with this same predicate via `isSafeJobId`);
//   - Kimi Code persists opaque session ids in KIMI_CODE_HOME/session_index.jsonl;
//   - relayd's own job ids are `crypto.randomUUID()`.
//
// Deliberately dependency-free (not even `config.mjs`, which creates
// directories at import time) so the jail module `sessionimport.mjs` can
// import it without pulling relayd's runtime configuration into a unit test.

const RESUMABLE_SESSION_ID_RE = /^[a-f0-9-]{36}$/;
const KIMI_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function isResumableSessionId(value) {
  return typeof value === "string" && RESUMABLE_SESSION_ID_RE.test(value);
}

function isKimiSessionId(value) {
  return typeof value === "string" && KIMI_SESSION_ID_RE.test(value);
}

function isThreadSessionId(value) {
  return isResumableSessionId(value) || isKimiSessionId(value);
}

export {
  RESUMABLE_SESSION_ID_RE,
  KIMI_SESSION_ID_RE,
  isResumableSessionId,
  isKimiSessionId,
  isThreadSessionId,
};
