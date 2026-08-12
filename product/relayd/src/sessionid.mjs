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
// THE CONTRACT, decided rather than widened: a resumable session id is a
// lowercase UUID-shaped token — exactly the 36 characters `crypto.randomUUID()`
// produces, which is also exactly what every harness this product resumes
// actually emits:
//
//   - Claude Code names its transcript `<uuid>.jsonl`;
//   - Codex records `payload.id` in the rollout's `session_meta` line as a
//     UUID (the rollout FILENAME carries a timestamp prefix as well — that
//     filename fragment is not the id, and treating it as one is the bug);
//   - `cursor-agent` reports `session_id` as a UUID (`adapters/cursor.mjs`
//     already validates it with this same predicate via `isSafeJobId`);
//   - relayd's own job ids are `crypto.randomUUID()`.
//
// It was deliberately NOT widened to match sessionimport's old allow-list:
// this same predicate backs `isSafeJobId`, which gates ids that become log
// filenames and URL path segments, and every character this excludes
// (`/`, `\`, `.`, NUL, newline, anything over 36 bytes) is one that has no
// business in either. Narrowing sessionimport to it is strictly safer than it
// was, and it makes "staged" and "resumable" the same set — which is the
// property that was missing.
//
// Deliberately dependency-free (not even `config.mjs`, which creates
// directories at import time) so the jail module `sessionimport.mjs` can
// import it without pulling relayd's runtime configuration into a unit test.

// Lowercase hex and dashes, exactly 36 characters. Positionally it is looser
// than a strict RFC-4122 UUID (it does not pin the dash offsets or the version
// nibble); that looseness is inherited from `isSafeJobId`, which has always had
// it, and is harmless — every string it admits is still a single, plain,
// bounded path component with no `.` and no separator.
const RESUMABLE_SESSION_ID_RE = /^[a-f0-9-]{36}$/;

function isResumableSessionId(value) {
  return typeof value === "string" && RESUMABLE_SESSION_ID_RE.test(value);
}

export { RESUMABLE_SESSION_ID_RE, isResumableSessionId };
