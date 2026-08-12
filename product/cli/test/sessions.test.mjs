import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const { discoverSessions, readSessionBytes, sessionExcerpt, claudeProjectSlug } = await import("../src/sessions.mjs");

const CWD = "/Users/dev/code/relay";

function writeClaudeSession(home, id, lines, mtime) {
  const file = path.join(home, ".claude", "projects", claudeProjectSlug(CWD), `${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

function writeCodexRollout(home, id, cwd, mtime) {
  const file = path.join(home, ".codex", "sessions", "2026", "08", `rollout-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ cwd, id })}\n${JSON.stringify({ type: "user", text: "codex work" })}\n`);
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return file;
}

test("claude sessions for this cwd are discovered, newest first", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-"));
  writeClaudeSession(home, "11111111-1111-4111-8111-111111111111",
    [{ type: "user", cwd: CWD, message: { content: "older question" } }], new Date("2026-08-10T10:00:00Z"));
  writeClaudeSession(home, "22222222-2222-4222-8222-222222222222",
    [{ type: "user", cwd: CWD, message: { content: "fix the auth redirect loop" } }], new Date("2026-08-11T10:00:00Z"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].id, "22222222-2222-4222-8222-222222222222");
  assert.equal(sessions[0].harness, "claude");
  assert.equal(sessions[0].format, "claude-jsonl");
  assert.match(sessions[0].title, /fix the auth redirect loop/i);
});

test("sessions belonging to another directory are not offered", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-other-"));
  const otherSlug = claudeProjectSlug("/Users/dev/code/unrelated");
  const file = path.join(home, ".claude", "projects", otherSlug, "33333333-3333-4333-8333-333333333333.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ type: "user", cwd: "/Users/dev/code/unrelated" })}\n`);

  assert.deepEqual(discoverSessions({ cwd: CWD, home }), []);
});

test("codex rollouts are matched by the cwd they record", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-codex-"));
  writeCodexRollout(home, "aaaa1111", CWD, new Date("2026-08-11T09:00:00Z"));
  writeCodexRollout(home, "bbbb2222", "/Users/dev/code/other", new Date("2026-08-11T09:30:00Z"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].harness, "codex");
  assert.equal(sessions[0].format, "codex-rollout");
  assert.equal(sessions[0].id, "aaaa1111");
});

test("an oversized session is reported but refuses to load", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-big-"));
  writeClaudeSession(home, "44444444-4444-4444-8444-444444444444",
    [{ type: "user", cwd: CWD, message: { content: "x".repeat(5000) } }]);

  const [session] = discoverSessions({ cwd: CWD, home });

  assert.ok(session.sizeBytes > 4000);
  assert.equal(readSessionBytes(session, { maxBytes: 1000 }), null, "over the cap, nothing is loaded");
  assert.ok(readSessionBytes(session, { maxBytes: 1_000_000 }).length > 4000);
});

test("an excerpt is bounded and drawn from the newest turns", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-exc-"));
  writeClaudeSession(home, "55555555-5555-4555-8555-555555555555", [
    { type: "user", cwd: CWD, message: { content: "first thing" } },
    { type: "assistant", message: { content: "the newest reply" } },
  ]);

  const excerpt = sessionExcerpt(discoverSessions({ cwd: CWD, home })[0], { maxChars: 100 });

  assert.ok(excerpt.length <= 100);
  assert.match(excerpt, /newest reply/);
});

test("no sessions anywhere yields an empty list rather than an error", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-empty-"));
  assert.deepEqual(discoverSessions({ cwd: CWD, home }), []);
});

// Not in the original brief: a live session's transcript file can have its
// last line partially flushed by the writing process. Discovery must tolerate
// a truncated trailing line rather than throwing, since a crash here would
// break handoff for anyone with a still-open session.
test("a truncated trailing line in a live session does not crash discovery", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-truncated-"));
  const file = writeClaudeSession(home, "66666666-6666-4666-8666-666666666666", [
    { type: "user", cwd: CWD, message: { content: "work in progress" } },
  ]);
  // Simulate a still-open writer: append a partially flushed JSON line with no newline.
  fs.appendFileSync(file, '{"type":"assistant","message":{"content":"cut off mid-wr');

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "work in progress");
  assert.doesNotThrow(() => sessionExcerpt(sessions[0], { maxChars: 100 }));
  assert.doesNotThrow(() => readSessionBytes(sessions[0], { maxBytes: 1_000_000 }));
});

test("a dangling symlink alongside a valid session does not abort discovery", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-dangling-"));
  writeClaudeSession(home, "77777777-7777-4777-8777-777777777777", [
    { type: "user", cwd: CWD, message: { content: "a valid session" } },
  ]);
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(CWD));
  const target = path.join(dir, "does-not-exist.jsonl");
  fs.symlinkSync(target, path.join(dir, "dangling.jsonl"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "77777777-7777-4777-8777-777777777777");
});

test("discovery of a very large session file does not read the whole file", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-oversized-"));
  const file = writeClaudeSession(home, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", [
    { type: "user", cwd: CWD, message: { content: "first turn" } },
  ]);
  // Pad the file well past any reasonable bounded-read cap.
  fs.appendFileSync(file, "z".repeat(3 * 1024 * 1024));

  const originalReadFileSync = fs.readFileSync;
  let calledOnBigFile = false;
  fs.readFileSync = (target, ...rest) => {
    if (target === file) calledOnBigFile = true;
    return originalReadFileSync(target, ...rest);
  };

  let sessions;
  try {
    sessions = discoverSessions({ cwd: CWD, home });
  } finally {
    fs.readFileSync = originalReadFileSync;
  }

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].title, "first turn");
  assert.ok(sessions[0].sizeBytes > 3 * 1024 * 1024);
  assert.equal(calledOnBigFile, false, "discovery should not load the whole file just to derive a title");
});

test("sessionExcerpt truncates to the newest turns when content exceeds maxChars", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-excbound-"));
  writeClaudeSession(home, "99999999-9999-4999-8999-999999999999", [
    { type: "user", cwd: CWD, message: { content: "OLDEST-" + "a".repeat(2000) } },
    { type: "assistant", message: { content: "MIDDLE-" + "b".repeat(2000) } },
    { type: "user", message: { content: "NEWEST-" + "c".repeat(2000) } },
  ]);

  const excerpt = sessionExcerpt(discoverSessions({ cwd: CWD, home })[0], { maxChars: 50 });

  assert.equal(excerpt.length, 50);
  assert.match(excerpt, /^c+$/, "the excerpt should be drawn from the tail of the newest turn, not the head");
  assert.doesNotMatch(excerpt, /OLDEST|MIDDLE/);
});

test("the scan cap is honoured even for a flat directory of rollout files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-cap-"));
  const dir = path.join(home, ".codex", "sessions", "flat");
  fs.mkdirSync(dir, { recursive: true });
  const total = 520;
  for (let i = 0; i < total; i += 1) {
    const id = String(i).padStart(4, "0");
    fs.writeFileSync(path.join(dir, `rollout-${id}.jsonl`), `${JSON.stringify({ cwd: CWD })}\n`);
  }

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.ok(sessions.length < total, "the flat-directory cap should stop examining files once the limit is hit");
});

test("claudeProjectSlug pins the exact slug format shared with relayd", () => {
  assert.equal(claudeProjectSlug("/Users/a/b"), "-Users-a-b");
});

test("codex cwd matching tolerates a trailing slash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-trailingslash-"));
  writeCodexRollout(home, "cccc3333", CWD + "/", new Date("2026-08-11T09:00:00Z"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "cccc3333");
});

// A directory can share a name with a session file (e.g. a stray mkdir, or a
// harness bug). Nothing here should treat it as a valid session just because
// its name ends in ".jsonl" — the type must be checked, not just the suffix.
test("a directory named *.jsonl is skipped, not treated as a valid session", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-dirjsonl-"));
  writeClaudeSession(home, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", [
    { type: "user", cwd: CWD, message: { content: "a valid session" } },
  ]);
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(CWD));
  fs.mkdirSync(path.join(dir, "foo.jsonl"));

  const sessions = discoverSessions({ cwd: CWD, home });

  assert.equal(sessions.length, 1, "the directory must not be counted as a session");
  assert.equal(sessions[0].id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
});

// discoverSessions is entirely synchronous (fs.openSync/readSync under the
// hood), so a hang inside it cannot be raced against a timer from within
// this same process — node:test's own `timeout` option only marks a hung
// test cancelled, it does not stop a still-blocked syscall (the same trap
// documented on the login.test.mjs budget test, for the sync case instead
// of the async one). The only reliable way to bound a genuinely synchronous
// hang is to run the call in a child process and let Node's own spawnSync
// `timeout` kill it from outside if it does not return in time.
function runDiscoverSessionsInChild({ cwd, home }, { timeout = 4000 } = {}) {
  const sessionsPath = new URL("../src/sessions.mjs", import.meta.url).pathname;
  const script = [
    `import { discoverSessions } from ${JSON.stringify(sessionsPath)};`,
    `const sessions = discoverSessions({ cwd: ${JSON.stringify(cwd)}, home: ${JSON.stringify(home)} });`,
    `process.stdout.write(JSON.stringify(sessions.map((s) => s.id)));`,
  ].join("\n");
  const scriptPath = path.join(home, "__probe.mjs");
  fs.writeFileSync(scriptPath, script);
  return spawnSync(process.execPath, [scriptPath], { timeout, killSignal: "SIGKILL", encoding: "utf8" });
}

test("a FIFO named *.jsonl in the Claude project dir does not hang discovery", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-fifo-claude-"));
  writeClaudeSession(home, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", [
    { type: "user", cwd: CWD, message: { content: "a valid session next to a fifo" } },
  ]);
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(CWD));
  const fifoPath = path.join(dir, "blocked.jsonl");
  const mkfifo = spawnSync("mkfifo", [fifoPath]);
  assert.equal(mkfifo.status, 0, "test setup requires mkfifo to succeed on this platform");

  const result = runDiscoverSessionsInChild({ cwd: CWD, home });

  assert.equal(result.signal, null, `discoverSessions hung and had to be killed (signal=${result.signal}); a FIFO must be skipped before it is ever opened`);
  assert.equal(result.status, 0, `probe exited abnormally: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"], "the fifo must be skipped; the valid session is still discovered");
});

test("a FIFO named rollout-*.jsonl in the Codex sessions dir does not hang discovery", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-sessions-fifo-codex-"));
  writeCodexRollout(home, "ffff4444", CWD, new Date("2026-08-11T09:00:00Z"));
  const dir = path.join(home, ".codex", "sessions", "2026", "08");
  const fifoPath = path.join(dir, "rollout-blocked.jsonl");
  const mkfifo = spawnSync("mkfifo", [fifoPath]);
  assert.equal(mkfifo.status, 0, "test setup requires mkfifo to succeed on this platform");

  const result = runDiscoverSessionsInChild({ cwd: CWD, home });

  assert.equal(result.signal, null, `discoverSessions hung and had to be killed (signal=${result.signal}); a FIFO must be skipped before it is ever opened`);
  assert.equal(result.status, 0, `probe exited abnormally: ${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), ["ffff4444"], "the fifo must be skipped; the valid session is still discovered");
});
