import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const {
  importSession, rewriteClaudeSession, claudeProjectSlug, summaryPrompt,
  assertContained, SessionImportSecurityError,
} = await import("../src/sessionimport.mjs");

const FROM_CWD = "/Users/dev/code/relay";
const TO_CWD = "/srv/relay-workspaces/handoff-abc123";
const SLUG = claudeProjectSlug(TO_CWD);

function manifest(overrides = {}) {
  return {
    v: 1, id: "abc123def4567890", harness: "claude", sessionId: "11111111-2222-4333-8444-555555555555",
    title: "Fix the auth redirect", repo: "me/relay", baseBranch: "main",
    branch: "relay/handoff-fix-the-auth-redirect", cwd: FROM_CWD, machine: "MacBook-Pro",
    createdAt: 1_800_000_000_000, sessionFormat: "claude-jsonl",
    wip: { files: 2, insertions: 30, deletions: 4, summary: "2 files changed" },
    excerpt: "I was tracing why the redirect loops.",
    ...overrides,
  };
}

function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-sessionimport-"));
  return { runHome: path.join(root, "home"), codexHome: path.join(root, "codex") };
}

// ---------------------------------------------------------------------------
// Escape detection.
//
// Round 1's "no file escaped" assertions were VACUOUS: they asserted on
// `/private/tmp/RELAYD-PWNED-DEMO` while the exploit actually wrote
// `...DEMO.jsonl`, so the assertion passed with the escape file sitting on
// disk. Never assert on a single predicted path again. Every attack below runs
// in its own arena — `jail/` (runHome + codexHome) next to `outside/` (victim
// territory) — and is judged by diffing a full recursive snapshot of the WHOLE
// arena. Anything created, modified or deleted outside the jail fails the
// test, whatever it turns out to be called.
//
// `assertNothingEscaped` is itself proven able to fail, by the
// "guards the guards" test below.

function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      let stat;
      try { stat = fs.lstatSync(p); } catch { continue; }
      const rel = path.relative(root, p);
      if (stat.isSymbolicLink()) {
        out.set(rel, `symlink -> ${fs.readlinkSync(p)}`);
      } else if (stat.isDirectory()) {
        out.set(rel, `dir mode=${(stat.mode & 0o777).toString(8)}`);
        walk(p);
      } else if (stat.isFile()) {
        let digest = "unreadable";
        try {
          digest = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
        } catch { /* keep the marker */ }
        out.set(rel, `file mode=${(stat.mode & 0o777).toString(8)} nlink=${stat.nlink} sha=${digest}`);
      } else {
        // FIFOs, sockets, devices: never read them — opening a FIFO blocks.
        out.set(rel, `special mode=${(stat.mode & 0o777).toString(8)} type=${stat.mode & 0o170000}`);
      }
    }
  };
  walk(root);
  return out;
}

function arena() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-arena-"));
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outside, "VICTIM.txt"), "ssh-rsa ORIGINAL\n");
  return {
    root, outside,
    victim: path.join(outside, "VICTIM.txt"),
    runHome: path.join(root, "jail", "home"),
    codexHome: path.join(root, "jail", "codex"),
    projectDir: path.join(root, "jail", "home", ".claude", "projects", SLUG),
    sessionsDir: path.join(root, "jail", "codex", "sessions"),
  };
}

// Every path OUTSIDE the jail — i.e. not under `jail/` — must be byte-for-byte
// what it was before the attack ran.
function assertNothingEscaped(a, before, why = "nothing may be written outside the jail") {
  const after = snapshot(a.root);
  const jailPrefix = "jail" + path.sep;
  const damage = [];
  for (const [key, value] of after) {
    if (key === "jail" || key.startsWith(jailPrefix)) continue;
    if (!before.has(key)) damage.push(`created ${key} (${value})`);
    else if (before.get(key) !== value) damage.push(`modified ${key} (${before.get(key)} -> ${value})`);
  }
  for (const key of before.keys()) {
    if (key === "jail" || key.startsWith(jailPrefix)) continue;
    if (!after.has(key)) damage.push(`deleted ${key}`);
  }
  if (damage.length > 0) {
    throw new assert.AssertionError({
      message: `${damage.length} path(s) escaped the jail — ${why}:\n  ${damage.join("\n  ")}`,
      actual: damage, expected: [], operator: "assertNothingEscaped",
    });
  }
}

// Run an attack and hand back whatever it threw, so the CANARY can be checked
// before the refusal is. Order matters: if the refusal assertion runs first it
// masks the canary, and "the escape happened but something threw afterwards"
// then reads as a pass — the exact shape of round 1's vacuity.
function attempt(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

// A refusal must be OUR error with OUR code — `assert.throws(fn)` with no
// matcher passes on an unrelated TypeError, which is how a guard replaced by a
// plain internal bug survived a previous round's mutation testing.
function assertRefusal(caught, code) {
  assert.ok(caught, `expected a refusal with code ${code}, but nothing was thrown`);
  assert.ok(
    caught instanceof SessionImportSecurityError,
    `expected SessionImportSecurityError, got ${caught?.name}: ${caught?.message}`,
  );
  assert.equal(caught.code, code, `wrong refusal code (message: ${caught.message})`);
  return caught;
}

function assertRefused(fn, code) {
  return assertRefusal(attempt(fn), code);
}

const claudeBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD, evil: "POISON" })}\n`, "utf8");
const codexBytes = Buffer.from(`${JSON.stringify({ record: "rollout", evil: "POISON" })}\n`, "utf8");

function attackClaude(a, sessionId = "33333333-4444-4444-8444-555555555555") {
  return () => importSession({
    manifest: manifest({ sessionId }),
    sessionBytes: claudeBytes, runHome: a.runHome, codexHome: a.codexHome, worktreePath: TO_CWD,
  });
}
function attackCodex(a, sessionId = "55555555-6666-4444-8444-555555555555") {
  return () => importSession({
    manifest: manifest({ harness: "codex", sessionFormat: "codex-rollout", sessionId }),
    sessionBytes: codexBytes, runHome: a.runHome, codexHome: a.codexHome, worktreePath: TO_CWD,
  });
}

// ---------------------------------------------------------------------------
// Behaviour

test("claudeProjectSlug matches Claude Code's directory naming", () => {
  assert.equal(claudeProjectSlug("/Users/dev/code/relay"), "-Users-dev-code-relay");
  assert.equal(claudeProjectSlug("/srv/relay-workspaces/handoff-abc"), "-srv-relay-workspaces-handoff-abc");
});

test("rewriteClaudeSession retargets the cwd without corrupting other text", () => {
  const line = JSON.stringify({ type: "user", cwd: FROM_CWD, message: `edit ${FROM_CWD}/src/a.ts and keep /Users/dev/other` });
  const rewritten = rewriteClaudeSession(`${line}\n`, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  const parsed = JSON.parse(rewritten.trim());

  assert.equal(parsed.cwd, TO_CWD);
  assert.equal(parsed.message, `edit ${TO_CWD}/src/a.ts and keep /Users/dev/other`);
  assert.ok(!rewritten.includes(FROM_CWD), "no laptop path survives the rewrite");
});

test("a claude session is staged where --resume finds it", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(
    `${JSON.stringify({ type: "user", cwd: FROM_CWD, message: "hello" })}\n`, "utf8");

  const result = importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });

  const staged = path.join(runHome, ".claude", "projects", SLUG,
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.ok(fs.existsSync(staged), "the session file is staged for resume");
  assert.equal(JSON.parse(fs.readFileSync(staged, "utf8").trim()).cwd, TO_CWD);
  assert.deepEqual(
    { provider: result.provider, resumeSessionId: result.resumeSessionId },
    { provider: "claude", resumeSessionId: "11111111-2222-4333-8444-555555555555" },
  );
  assert.deepEqual(
    fs.readdirSync(path.dirname(staged)),
    ["11111111-2222-4333-8444-555555555555.jsonl"],
    "no staging temp file is left behind",
  );
});

test("a codex rollout is staged under the codex home unmodified", () => {
  const { runHome, codexHome } = homes();
  const rollout = Buffer.from(`${JSON.stringify({ record: "rollout", cwd: FROM_CWD })}\n`, "utf8");

  const result = importSession({
    manifest: manifest({ harness: "codex", sessionFormat: "codex-rollout", sessionId: "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000" }),
    sessionBytes: rollout, runHome, codexHome, worktreePath: TO_CWD,
  });

  const staged = path.join(codexHome, "sessions", "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000.jsonl");
  assert.deepEqual(fs.readFileSync(staged), rollout, "codex rollouts are byte-preserved");
  assert.equal(result.resumeSessionId, "0199aaaa-bbbb-4ccc-8ddd-eeeeffff0000");
  assert.equal(result.provider, "codex");
});

test("re-importing over a session file we staged earlier replaces it", () => {
  const { runHome, codexHome } = homes();
  const first = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD, n: 1 })}\n`, "utf8");
  const second = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD, n: 2 })}\n`, "utf8");
  importSession({ manifest: manifest(), sessionBytes: first, runHome, codexHome, worktreePath: TO_CWD });
  importSession({ manifest: manifest(), sessionBytes: second, runHome, codexHome, worktreePath: TO_CWD });

  const staged = path.join(runHome, ".claude", "projects", SLUG,
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.equal(JSON.parse(fs.readFileSync(staged, "utf8").trim()).n, 2);
  assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(staged)).length, 1, "no staging temp file is left behind");
});

test("a session-less handoff falls back to a primed prompt", () => {
  const { runHome, codexHome } = homes();
  const result = importSession({
    manifest: manifest({ harness: "cursor", sessionFormat: "none", sessionId: null }),
    sessionBytes: null, runHome, codexHome, worktreePath: TO_CWD,
  });

  assert.equal(result.resumeSessionId, null);
  assert.equal(result.provider, "cursor");
  assert.match(result.primedPrompt, /Fix the auth redirect/);
  assert.match(result.primedPrompt, /I was tracing why the redirect loops\./);
  assert.match(result.primedPrompt, /2 files changed/);
});

test("staged session files are private to the runner", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });
  const staged = path.join(runHome, ".claude", "projects", SLUG,
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
});

test("staged directories (not just the leaf file) are 0700, including the jail root", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });

  let dir = path.join(runHome, ".claude", "projects", SLUG);
  while (dir.startsWith(runHome)) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${dir} must be 0700`);
    if (dir === runHome) break;
    dir = path.dirname(dir);
  }
});

test("summaryPrompt never fabricates content it was not given", () => {
  const prompt = summaryPrompt(manifest({ excerpt: "", wip: { files: 0, insertions: 0, deletions: 0, summary: "" } }));
  assert.match(prompt, /Fix the auth redirect/);
  assert.ok(!prompt.includes("undefined"), "empty fields are omitted, not stringified");
});

test("summaryPrompt never emits 'undefined' or 'null' when repo/branch are missing", () => {
  const prompt = summaryPrompt(manifest({ repo: undefined, branch: undefined }));
  assert.ok(!prompt.includes("undefined"), "missing repo/branch must not stringify to 'undefined'");
  assert.ok(!prompt.includes("null"), "missing repo/branch must not stringify to 'null'");
});

test("summaryPrompt never emits 'undefined' when manifest.title is missing", () => {
  const prompt = summaryPrompt(manifest({ title: undefined }));
  assert.ok(!prompt.includes("undefined"), "a missing title must not stringify to 'undefined'");
});

test("an unrecognized harness degrades to claude observably", () => {
  const { runHome, codexHome } = homes();
  const result = importSession({
    manifest: manifest({ harness: "some-future-harness", sessionFormat: "none", sessionId: null }),
    sessionBytes: null, runHome, codexHome, worktreePath: TO_CWD,
  });
  assert.equal(result.provider, "claude", "unrecognized harnesses fall back to claude");
  assert.equal(result.requestedHarness, "some-future-harness", "the originally-requested harness is still visible");
});

// ---------------------------------------------------------------------------
// The detector, and the assertions that depend on it

test("GUARDS THE GUARDS: the escape detector actually fails on a real escape", () => {
  // If this test ever passes vacuously, every negative assertion below is
  // worthless. Plant each kind of damage outside the jail and confirm the
  // detector reports it.
  const a = arena();
  const before = snapshot(a.root);
  assert.doesNotThrow(() => assertNothingEscaped(a, before), "a clean arena must not report damage");

  fs.writeFileSync(path.join(a.outside, "PLANTED-BY-THE-TEST.jsonl"), "x");
  assert.throws(() => assertNothingEscaped(a, before), /escaped the jail[\s\S]*created outside/);

  const b = arena();
  const beforeB = snapshot(b.root);
  fs.writeFileSync(b.victim, "CLOBBERED\n");
  assert.throws(() => assertNothingEscaped(b, beforeB), /escaped the jail[\s\S]*modified outside/);

  const c = arena();
  const beforeC = snapshot(c.root);
  fs.mkdirSync(path.join(c.outside, "a", "b"), { recursive: true });
  assert.throws(() => assertNothingEscaped(c, beforeC), /escaped the jail[\s\S]*created outside/);

  const d = arena();
  const beforeD = snapshot(d.root);
  fs.unlinkSync(d.victim);
  assert.throws(() => assertNothingEscaped(d, beforeD), /escaped the jail[\s\S]*deleted outside/);

  // ...and writes INSIDE the jail are not escapes, or every test would pass.
  const e = arena();
  const beforeE = snapshot(e.root);
  fs.mkdirSync(e.projectDir, { recursive: true });
  fs.writeFileSync(path.join(e.projectDir, "legit.jsonl"), "x");
  assert.doesNotThrow(() => assertNothingEscaped(e, beforeE));
});

test("GUARDS THE GUARDS: assertRefused fails on an unrelated error type", () => {
  // The previous round's symlink tests used bare `assert.throws(fn)` and stayed
  // green when both containment errors were replaced with an unrelated
  // TypeError. assertRefused must not.
  assert.throws(() => assertRefused(() => { throw new TypeError("unrelated internal bug"); }, "jail_escape_symlinked_leaf"),
    /expected SessionImportSecurityError/);
  assert.throws(() => assertRefused(() => {}, "jail_escape_symlinked_leaf"),
    /nothing was thrown/);
  assert.throws(() => assertRefused(() => { throw new SessionImportSecurityError("some_other_code", "x"); }, "jail_escape_symlinked_leaf"),
    /wrong refusal code/);
});

// ---------------------------------------------------------------------------
// sessionId validation (the round-1 escape)

test("importSession rejects a sessionId that path-traverses outside runHome (claude branch)", () => {
  const a = arena();
  const evilId = "../".repeat(20) + a.outside.replace(/^\//, "") + "/RELAYD-PWNED-DEMO";
  const before = snapshot(a.root);
  const err = attempt(attackClaude(a, evilId));
  assertNothingEscaped(a, before);
  assertRefusal(err, "unsafe_session_id");
});

test("importSession rejects a sessionId that path-traverses outside codexHome (codex branch)", () => {
  const a = arena();
  const evilId = "../".repeat(20) + a.outside.replace(/^\//, "") + "/RELAYD-PWNED-DEMO-CODEX";
  const before = snapshot(a.root);
  const err = attempt(attackCodex(a, evilId));
  assertNothingEscaped(a, before);
  assertRefusal(err, "unsafe_session_id");
});

for (const [label, evilId] of [
  ["an absolute-path sessionId", "/etc/RELAYD-PWNED-ABS"],
  ["a sessionId containing a forward slash", "abc/def"],
  ["a sessionId containing a backslash", "..\\..\\evil"],
  ["a sessionId that is exactly '..'", ".."],
  ["a sessionId that hides '..' mid-string", "a..b"],
  ["a sessionId starting with a dot", ".hidden"],
  ["a sessionId containing a NUL", "abc .jsonl"],
  ["a sessionId containing a newline", "abc\ndef"],
  ["an over-long sessionId", "a".repeat(200)],
  ["a non-string sessionId", 12345],
]) {
  test(`importSession rejects ${label}, on both branches`, () => {
    for (const attack of [attackClaude, attackCodex]) {
      const a = arena();
      const before = snapshot(a.root);
      const err = attempt(attack(a, evilId));
      assertNothingEscaped(a, before);
      assertRefusal(err, "unsafe_session_id");
    }
  });
}

test("the refusal message never echoes back an unbounded slab of attacker input", () => {
  const a = arena();
  const err = assertRefused(attackClaude(a, "A".repeat(4096)), "unsafe_session_id");
  assert.ok(err.message.length < 200, `error message must be bounded, got ${err.message.length} chars`);
  assert.match(err.message, /\(\+4048 more\)/);
});

test("assertContained rejects a sibling directory that merely shares a prefix", () => {
  assertRefused(() => assertContained("/srv/relay", "/srv/relay-evil/x"), "unsafe_session_id");
  assertRefused(() => assertContained("/srv/relay", "/srv/relayevil"), "unsafe_session_id");
});

test("assertContained accepts a genuine child path", () => {
  assert.doesNotThrow(() => assertContained("/srv/relay", "/srv/relay/x"));
  assert.doesNotThrow(() => assertContained("/srv/relay", "/srv/relay"));
});

// ---------------------------------------------------------------------------
// The jail: one test per link mechanism, per level, per branch.
//
// Coverage follows the exploits, not the fix. A shallow "is the write
// directory a symlink / is the leaf a symlink" check — which is what the
// previous round's suite could not distinguish from real containment — passes
// the leaf and project-dir cases and fails every INTERMEDIATE case below.
// A containment check rooted at runHome/codexHome (rather than pinning every
// component) passes the outside-the-home cases and fails every
// inside-the-home case below.

const LINK_ATTACKS = [
  {
    name: "a symlinked `.claude` (intermediate component, claude branch)",
    code: "jail_escape_symlinked_component",
    setup: (a) => {
      fs.mkdirSync(a.runHome, { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.outside, path.join(a.runHome, ".claude"));
      return attackClaude(a);
    },
  },
  {
    name: "a symlinked `projects` (intermediate component, claude branch)",
    code: "jail_escape_symlinked_component",
    setup: (a) => {
      fs.mkdirSync(path.join(a.runHome, ".claude"), { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.outside, path.join(a.runHome, ".claude", "projects"));
      return attackClaude(a);
    },
  },
  {
    name: "a RELATIVE symlink chain at `.claude` (claude branch)",
    code: "jail_escape_symlinked_component",
    setup: (a) => {
      fs.mkdirSync(a.runHome, { recursive: true, mode: 0o700 });
      fs.symlinkSync(path.join("..", "..", "outside"), path.join(a.runHome, ".claude"));
      return attackClaude(a);
    },
  },
  {
    name: "a symlinked project directory (claude branch)",
    code: "jail_escape_symlinked_component",
    setup: (a) => {
      fs.mkdirSync(path.dirname(a.projectDir), { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.outside, a.projectDir);
      return attackClaude(a);
    },
  },
  {
    name: "a symlinked sessions directory (codex branch)",
    code: "jail_escape_symlinked_component",
    setup: (a) => {
      fs.mkdirSync(a.codexHome, { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.outside, a.sessionsDir);
      return attackCodex(a);
    },
  },
  {
    name: "a symlinked leaf session file (claude branch)",
    code: "jail_escape_symlinked_leaf",
    setup: (a) => {
      fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.victim, path.join(a.projectDir, "33333333-4444-4444-8444-555555555555.jsonl"));
      return attackClaude(a);
    },
  },
  {
    name: "a symlinked leaf rollout file (codex branch)",
    code: "jail_escape_symlinked_leaf",
    setup: (a) => {
      fs.mkdirSync(a.sessionsDir, { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.victim, path.join(a.sessionsDir, "55555555-6666-4444-8444-555555555555.jsonl"));
      return attackCodex(a);
    },
  },
  {
    name: "a HARD LINK at the leaf session file (claude branch)",
    code: "jail_escape_hardlinked_leaf",
    setup: (a) => {
      // O_NOFOLLOW does nothing about hard links, and a hard link has no
      // link-ness to detect at the path level: opening this name writes
      // straight into the victim outside the jail.
      fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
      fs.linkSync(a.victim, path.join(a.projectDir, "33333333-4444-4444-8444-555555555555.jsonl"));
      return attackClaude(a);
    },
  },
  {
    name: "a HARD LINK at the leaf rollout file (codex branch)",
    code: "jail_escape_hardlinked_leaf",
    setup: (a) => {
      fs.mkdirSync(a.sessionsDir, { recursive: true, mode: 0o700 });
      fs.linkSync(a.victim, path.join(a.sessionsDir, "55555555-6666-4444-8444-555555555555.jsonl"));
      return attackCodex(a);
    },
  },
  {
    name: "a leaf that is a directory rather than a file (claude branch)",
    code: "jail_escape_leaf_not_a_regular_file",
    setup: (a) => {
      fs.mkdirSync(path.join(a.projectDir, "33333333-4444-4444-8444-555555555555.jsonl"), { recursive: true });
      return attackClaude(a);
    },
  },
  {
    name: "a symlinked jail root itself (claude branch)",
    code: "jail_root_is_symlink",
    setup: (a) => {
      fs.mkdirSync(path.dirname(a.runHome), { recursive: true, mode: 0o700 });
      fs.symlinkSync(a.outside, a.runHome);
      return attackClaude(a);
    },
  },
];

for (const attack of LINK_ATTACKS) {
  test(`importSession refuses ${attack.name}`, () => {
    const a = arena();
    const run = attack.setup(a);
    const before = snapshot(a.root);
    const err = attempt(run);
    // Canary first, refusal second — always, everywhere in this file.
    assertNothingEscaped(a, before);
    // Belt and braces on the highest-value single fact: the victim's bytes.
    if (fs.existsSync(a.victim)) {
      assert.equal(fs.readFileSync(a.victim, "utf8"), "ssh-rsa ORIGINAL\n",
        "the file outside the jail must be byte-for-byte unchanged");
    }
    assertRefusal(err, attack.code);
  });
}

test("importSession refuses a regular file where a staging directory belongs", () => {
  const a = arena();
  fs.mkdirSync(a.runHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(a.runHome, ".claude"), "not a directory\n");
  const before = snapshot(a.root);
  const err = attempt(attackClaude(a));
  assertNothingEscaped(a, before);
  assertRefusal(err, "jail_escape_not_a_directory");
});

test("importSession refuses a FIFO at a staging path component instead of blocking on it", (t) => {
  // A FIFO planted at a path component hangs `open()` forever until a writer
  // shows up — a denial of service on the whole handoff pipeline, from a
  // single mkfifo. O_DIRECTORY is what makes this ENOTDIR instead of a hang.
  const a = arena();
  fs.mkdirSync(a.runHome, { recursive: true, mode: 0o700 });
  try {
    execFileSync("mkfifo", [path.join(a.runHome, ".claude")], { stdio: "ignore" });
  } catch {
    t.skip("mkfifo is unavailable on this platform");
    return;
  }
  const before = snapshot(a.root);
  const err = attempt(attackClaude(a));
  assertNothingEscaped(a, before);
  assertRefusal(err, "jail_escape_not_a_directory");
});

// ---------------------------------------------------------------------------
// Escapes that never leave runHome/codexHome.
//
// These are the ones a containment check rooted at the HOME directory cannot
// see, because everything they touch is "inside the jail root" — and they are
// the highest-value targets in the tree: a poisoned transcript is fed straight
// back to a coding agent with tool access, and codexHome holds auth.json.

test("importSession refuses to poison a SIBLING workspace's transcript directory", () => {
  const a = arena();
  const projects = path.join(a.runHome, ".claude", "projects");
  const victimWorkspace = path.join(projects, "-srv-relay-workspaces-SOMEONE-ELSE");
  fs.mkdirSync(victimWorkspace, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(victimWorkspace, "pre-existing.jsonl"), "someone else's transcript\n", { mode: 0o600 });
  fs.symlinkSync(victimWorkspace, a.projectDir);

  const err = attempt(attackClaude(a));
  assert.deepEqual(fs.readdirSync(victimWorkspace), ["pre-existing.jsonl"],
    "a sibling workspace's transcript directory must not gain a file");
  assert.equal(fs.readFileSync(path.join(victimWorkspace, "pre-existing.jsonl"), "utf8"),
    "someone else's transcript\n");
  assertRefusal(err, "jail_escape_symlinked_component");
});

test("importSession refuses to write into the runHome root itself", () => {
  const a = arena();
  const projects = path.join(a.runHome, ".claude", "projects");
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  fs.symlinkSync(a.runHome, a.projectDir);

  const err = attempt(attackClaude(a));
  assert.deepEqual(fs.readdirSync(a.runHome).sort(), [".claude"],
    "nothing may be dropped at the top of the run home");
  assertRefusal(err, "jail_escape_symlinked_component");
});

test("importSession refuses to write next to codexHome/auth.json", () => {
  const a = arena();
  fs.mkdirSync(a.codexHome, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(a.codexHome, "auth.json"), "{\"token\":\"secret\"}\n", { mode: 0o600 });
  fs.symlinkSync(a.codexHome, a.sessionsDir);

  const err = attempt(attackCodex(a));
  assert.deepEqual(fs.readdirSync(a.codexHome).sort(), ["auth.json", "sessions"],
    "nothing may be dropped next to the codex credentials");
  assert.equal(fs.readFileSync(path.join(a.codexHome, "auth.json"), "utf8"), "{\"token\":\"secret\"}\n");
  assertRefusal(err, "jail_escape_symlinked_component");
});

test("importSession refuses to write into .claude next to settings.local.json", () => {
  const a = arena();
  const claudeDir = path.join(a.runHome, ".claude");
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(claudeDir, "settings.local.json"), "{}\n", { mode: 0o600 });
  fs.symlinkSync(claudeDir, a.projectDir);

  const err = attempt(attackClaude(a));
  assert.deepEqual(fs.readdirSync(claudeDir).sort(), ["projects", "settings.local.json"]);
  assertRefusal(err, "jail_escape_symlinked_component");
});

test("a failed descent leaves no directory behind — inside the jail or outside it", () => {
  // mkdirSync(recursive) followed the symlink and created directories on the
  // far side of it before any check could fire. Component-wise creation must
  // not, and whatever it did create on the way must be taken back out.
  const a = arena();
  fs.mkdirSync(a.runHome, { recursive: true, mode: 0o700 });
  fs.symlinkSync(a.outside, path.join(a.runHome, ".claude"));
  const before = snapshot(a.root);

  const err = attempt(attackClaude(a));
  assertNothingEscaped(a, before);
  assert.deepEqual(fs.readdirSync(a.outside).sort(), ["VICTIM.txt"],
    "no directory may be created through a symlinked intermediate component");
  assertRefusal(err, "jail_escape_symlinked_component");
});

test("a pre-planted staging directory and leaf are brought back to 0700/0600", () => {
  const a = arena();
  fs.mkdirSync(a.projectDir, { recursive: true });
  fs.chmodSync(a.projectDir, 0o755);
  fs.chmodSync(path.join(a.runHome, ".claude"), 0o755);
  const leaf = path.join(a.projectDir, "33333333-4444-4444-8444-555555555555.jsonl");
  fs.writeFileSync(leaf, "stale\n");
  fs.chmodSync(leaf, 0o644);

  attackClaude(a)();

  assert.equal(fs.statSync(a.projectDir).mode & 0o777, 0o700, "an adopted directory must be re-tightened");
  assert.equal(fs.statSync(path.join(a.runHome, ".claude")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(leaf).mode & 0o777, 0o600, "an adopted leaf must not keep its loose mode");
});

test("a hostile leaf is refused BEFORE anything is truncated", () => {
  // O_TRUNC in the open flags destroyed the victim before any check could run,
  // so a guard that threw afterwards still left the file empty.
  const a = arena();
  fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
  fs.linkSync(a.victim, path.join(a.projectDir, "33333333-4444-4444-8444-555555555555.jsonl"));

  const err = attempt(attackClaude(a));
  assert.equal(fs.readFileSync(a.victim, "utf8"), "ssh-rsa ORIGINAL\n");
  assert.equal(fs.statSync(a.victim).size, 17, "the victim must not have been truncated");
  assertRefusal(err, "jail_escape_hardlinked_leaf");
});

// ---------------------------------------------------------------------------
// Races (I-2).
//
// The module does `import fs from "node:fs"`, which is the same mutable object
// this file holds, so the attacker can be made to WIN the race deterministically
// at a chosen syscall boundary instead of us hoping a real one is too narrow to
// hit. node:test runs the tests in a file sequentially, and every hook is
// removed in a `finally`, so nothing leaks into another test.

function withHook(name, nth, action, body) {
  const original = fs[name];
  let calls = 0;
  fs[name] = (...args) => {
    const out = original(...args);
    calls += 1;
    if (calls === nth) action();
    return out;
  };
  try { return body(); } finally { fs[name] = original; }
}

// Fires once, on the first call whose arguments match — and fires even if that
// call threw (the leaf pre-check lstat throws ENOENT on the happy path).
function withHookWhen(name, predicate, action, body) {
  const original = fs[name];
  let fired = false;
  fs[name] = (...args) => {
    try {
      return original(...args);
    } finally {
      if (!fired && predicate(args)) { fired = true; action(); }
    }
  };
  try { return body(); } finally { fs[name] = original; }
}

test("RACE: a staging component swapped for a symlink after it was verified is caught, and leaves nothing behind", () => {
  // `projects` is verified (open #2), and the attacker replaces it with a
  // symlink out of the jail before the next level is created. Path-based
  // re-resolution cannot be made atomic in Node — so the requirement is that
  // this ends loudly and leaves no residue, not that it is impossible.
  const a = arena();
  const projects = path.join(a.runHome, ".claude", "projects");
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const before = snapshot(a.root);

  const err = withHook("openSync", 2, () => {
    fs.renameSync(projects, `${projects}.stashed`);
    fs.symlinkSync(a.outside, projects);
  }, () => attempt(attackClaude(a)));

  assertNothingEscaped(a, before, "a lost race must still leave the far side of the symlink untouched");
  assert.deepEqual(fs.readdirSync(a.outside).sort(), ["VICTIM.txt"],
    "directories created through the swapped component must be unwound");
  assertRefusal(err, "jail_escape_realpath_mismatch");
});

test("RACE: a component swapped for a symlink to a directory that does not exist yet creates NOTHING outside the jail", () => {
  // This is why the descent uses a NON-recursive mkdir. `mkdirSync(recursive)`
  // would happily build the missing chain on the far side of the symlink, and
  // the unwind cannot take back a level it never knew it created.
  const a = arena();
  const projects = path.join(a.runHome, ".claude", "projects");
  fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
  const before = snapshot(a.root);

  const err = withHook("openSync", 2, () => {
    fs.renameSync(projects, `${projects}.stashed`);
    fs.symlinkSync(path.join(a.outside, "does-not-exist-yet"), projects);
  }, () => attempt(attackClaude(a)));

  assertNothingEscaped(a, before);
  assert.deepEqual(fs.readdirSync(a.outside).sort(), ["VICTIM.txt"]);
  assertRefusal(err, "jail_mkdir_failed");
});

test("RACE: the staging directory swapped between verification and the staging open is caught", () => {
  // The window between "this directory is real and inside the jail" and
  // "create a file in it". Losing it must not put a single byte outside.
  const a = arena();
  fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
  const before = snapshot(a.root);
  // Match on the leaf NAME, not the full path: the module works in realpaths
  // (/private/var/... on macOS) while the arena is built on /var/....
  const leafName = "33333333-4444-4444-8444-555555555555.jsonl";

  const err = withHookWhen("lstatSync", (args) => typeof args[0] === "string" && args[0].endsWith(leafName), () => {
    fs.renameSync(a.projectDir, `${a.projectDir}.stashed`);
    fs.symlinkSync(a.outside, a.projectDir);
  }, () => attempt(attackClaude(a)));

  assertNothingEscaped(a, before, "a staging file created through a swapped directory must be removed again");
  assertRefusal(err, "jail_escape_staging_race");
});

test("a pre-planted staging file is refused, never written through", () => {
  // The staging name is 128 bits of randomness precisely so an attacker cannot
  // pre-place it — but O_EXCL is what turns "cannot predict" into "cannot
  // matter". Force the collision to prove the flag is there.
  const a = arena();
  fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
  const originalRandomBytes = crypto.randomBytes;
  crypto.randomBytes = () => Buffer.alloc(16, 0xab);
  const collision = path.join(a.projectDir, `.relayd-import-${"ab".repeat(16)}.tmp`);
  const planted = "PLANTED CONTENT THAT MUST SURVIVE, AND IS LONGER THAN THE TRANSCRIPT WE WOULD WRITE\n";
  fs.writeFileSync(collision, planted);

  try {
    assertRefused(attackClaude(a), "jail_staging_open_failed");
  } finally {
    crypto.randomBytes = originalRandomBytes;
  }
  assert.equal(fs.readFileSync(collision, "utf8"), planted,
    "an existing file at the staging name must not be opened, written or truncated");
});

test("RACE: the staging file being hard-linked during the write is caught", () => {
  // The content write goes to an fd we own, so the bytes cannot be redirected
  // — but if someone links our staging file while we write it, we say so.
  const a = arena();
  fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
  const mirror = path.join(a.runHome, "MIRROR");

  withHook("fchmodSync", 1, () => {
    const tmp = fs.readdirSync(a.projectDir).find((n) => n.startsWith(".relayd-import-"));
    if (tmp) fs.linkSync(path.join(a.projectDir, tmp), mirror);
  }, () => {
    assertRefused(attackClaude(a), "jail_escape_staging_race");
  });

  assert.deepEqual(
    fs.readdirSync(a.projectDir), [],
    "the abandoned staging file must be cleaned up, not left as a partial transcript",
  );
});

test("RACE: a published file that is not the inode we staged is caught", () => {
  const a = arena();
  fs.mkdirSync(a.projectDir, { recursive: true, mode: 0o700 });
  const leaf = path.join(a.projectDir, "33333333-4444-4444-8444-555555555555.jsonl");

  withHook("renameSync", 1, () => {
    // The attacker swaps our just-published file for one of their own in the
    // instant after the rename.
    fs.unlinkSync(leaf);
    fs.writeFileSync(leaf, "attacker content\n");
  }, () => {
    assertRefused(attackClaude(a), "jail_escape_publish_race");
  });
});

// ---------------------------------------------------------------------------
// rewriteClaudeSession

test("rewriteClaudeSession treats a $-bearing toCwd as a literal replacement, not a replace-pattern", () => {
  // String.prototype.replace gives $&, $`, $', $1... special meaning in a
  // *string* replacement (insert the match / pre-match / post-match / a
  // capture group). rewriteClaudeSession must never interpret toCwd that way.
  const weirdCwds = {
    "$&": `${TO_CWD}-$&-marker`,
    "$`": "$`-" + TO_CWD,
    "$'": `${TO_CWD}-$'-marker`,
    "$1": `${TO_CWD}-$1-marker`,
  };
  for (const [label, weirdToCwd] of Object.entries(weirdCwds)) {
    const text = JSON.stringify({ cwd: FROM_CWD, message: `working in ${FROM_CWD}` });
    const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: weirdToCwd });
    assert.ok(rewritten.includes(weirdToCwd), `[${label}] replacement text must appear verbatim, got: ${rewritten}`);
    assert.ok(!rewritten.includes(FROM_CWD), `[${label}] no laptop path should survive the rewrite`);
  }
});

test("rewriteClaudeSession does not corrupt sibling paths that share a prefix", () => {
  // Real sibling directory names routinely start with these characters, so
  // they must NOT be treated as a path boundary.
  const siblings = ["-old", "ground", "+plus", "~1", "(copy)", "@2", ".bak", "_tmp", "#3", "[1]"];
  for (const suffix of siblings) {
    const sibling = `${FROM_CWD}${suffix}`;
    const text = JSON.stringify({ path: sibling });
    const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
    assert.equal(JSON.parse(rewritten).path, sibling, `sibling must survive untouched: ${sibling}`);
  }
});

test("rewriteClaudeSession leaves no laptop path behind in any realistic JSONL context", () => {
  // The laptop absolute path contains the user's real username, and the whole
  // point of the rewrite is that it does not reach the sandbox. A transcript
  // is mostly stack traces, grep output, shell lines and prose, so the
  // boundary class has to terminate on their punctuation. Round 3's class
  // leaked every one of these.
  const contexts = [
    ["comma in prose", `see ${FROM_CWD}, then run`],
    ["close paren", `(cd ${FROM_CWD})`],
    ["colon in a stack frame", `${FROM_CWD}:12:3`],
    ["semicolon in a shell line", `${FROM_CWD}; ls`],
    ["backtick in markdown", `\`${FROM_CWD}\``],
    ["equals in an env dump", `PWD=${FROM_CWD}=x`],
    ["question mark", `${FROM_CWD}?`],
    ["exclamation mark", `${FROM_CWD}!`],
    ["ellipsis", `${FROM_CWD}...`],
    ["angle brackets", `<${FROM_CWD}>`],
    ["pipe", `${FROM_CWD}|wc -l`],
    ["closing brace", `{"a":"${FROM_CWD}"}`],
    ["closing bracket", `[${FROM_CWD}]`],
    ["ampersand", `${FROM_CWD}&`],
    ["subpath", `${FROM_CWD}/src/a.ts`],
    ["bare, end of input", `working in ${FROM_CWD}`],
    ["trailing period, end of input", `working in ${FROM_CWD}.`],
    ["embedded quote as JSON serializes it", JSON.stringify({ m: `prefix ${FROM_CWD}" suffix` })],
  ];
  for (const [label, text] of contexts) {
    const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
    assert.ok(!rewritten.includes(FROM_CWD), `[${label}] laptop path leaked: ${rewritten}`);
    assert.ok(rewritten.includes(TO_CWD), `[${label}] sandbox path missing: ${rewritten}`);
  }
});

test("rewriteClaudeSession works LINE BY LINE, because the only real input is multi-line JSONL", () => {
  // The `m` flag is load-bearing: without it, the end-of-input clause is dead
  // code for every input this function actually sees in production, and a test
  // built on a single-line fixture asserts a behaviour that does not exist.
  const jsonl = [
    JSON.stringify({ type: "user", cwd: FROM_CWD }),
    JSON.stringify({ type: "assistant", text: `it ran at ${FROM_CWD}:44, then ${FROM_CWD}, fine` }),
    `plain trailing period line: working in ${FROM_CWD}.`,
    `bare at end of line: ${FROM_CWD}`,
    JSON.stringify({ type: "user", text: `cd ${FROM_CWD}; make` }),
  ].join("\n") + "\n";

  const rewritten = rewriteClaudeSession(jsonl, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  assert.ok(!rewritten.includes(FROM_CWD), `laptop path survived multi-line rewrite:\n${rewritten}`);
  assert.equal(rewritten.split("\n").length, jsonl.split("\n").length, "line structure must be preserved");
  assert.equal(JSON.parse(rewritten.split("\n")[0]).cwd, TO_CWD);
  assert.doesNotThrow(() => JSON.parse(rewritten.split("\n")[1]));
});

test("rewriteClaudeSession still rewrites all legitimate boundary cases and stays valid JSON", () => {
  const text = JSON.stringify({
    subpath: `${FROM_CWD}/src/a.ts`,
    end: FROM_CWD,
    quoted: `prefix ${FROM_CWD}" suffix`,
  });
  const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  assert.doesNotThrow(() => JSON.parse(rewritten), "output must still parse as JSON");
  const parsed = JSON.parse(rewritten);

  assert.equal(parsed.subpath, `${TO_CWD}/src/a.ts`);
  assert.equal(parsed.end, TO_CWD);
  assert.equal(parsed.quoted, `prefix ${TO_CWD}" suffix`);
});

test("rewriteClaudeSession escapes regex metacharacters in fromCwd", () => {
  const metaFrom = "/Users/dev/code/relay+old.checkout";
  const text = JSON.stringify({
    exact: metaFrom,
    sub: `${metaFrom}/file.ts`,
    sibling: `${metaFrom}-sibling`,
  });
  const rewritten = rewriteClaudeSession(text, { fromCwd: metaFrom, toCwd: TO_CWD });
  const parsed = JSON.parse(rewritten);

  assert.equal(parsed.exact, TO_CWD);
  assert.equal(parsed.sub, `${TO_CWD}/file.ts`);
  assert.equal(parsed.sibling, `${metaFrom}-sibling`, "sibling must survive even with metacharacters in fromCwd");
});

test("rewriteClaudeSession still rewrites a cwd immediately followed by sentence-ending punctuation", () => {
  const text = `working in ${FROM_CWD}.`;
  const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  assert.equal(rewritten, `working in ${TO_CWD}.`);
  assert.ok(!rewritten.includes(FROM_CWD), "no laptop path should survive the rewrite");
});

test("a non-string manifest.cwd is a named refusal, not a raw TypeError", () => {
  // Every other untrusted manifest field gets a typed, named rejection; this
  // one used to reach `.replace()` and die with an implementation detail the
  // caller could not tell from a bug.
  for (const bad of [12345, {}, [], true]) {
    assertRefused(() => rewriteClaudeSession("x", { fromCwd: bad, toCwd: TO_CWD }), "unsafe_manifest_cwd");
  }
  assertRefused(() => rewriteClaudeSession("x", { fromCwd: FROM_CWD, toCwd: 7 }), "unsafe_worktree_path");
  // ...but an absent cwd is legitimate (a manifest with no cwd needs no rewrite).
  assert.equal(rewriteClaudeSession("x", { fromCwd: undefined, toCwd: TO_CWD }), "x");
  assert.equal(rewriteClaudeSession("x", { fromCwd: null, toCwd: TO_CWD }), "x");
  assert.equal(rewriteClaudeSession("x", { fromCwd: "", toCwd: TO_CWD }), "x");
});

test("rewriteClaudeSession is not an unbounded memory amplifier", () => {
  const big = "x".repeat(200_000);
  // A one-character "cwd" would rewrite every single character of the
  // transcript — measured at 58x on a hostile manifest.
  assert.equal(rewriteClaudeSession(big, { fromCwd: "x", toCwd: "y".repeat(60) }).length, big.length);
  // Anything that could still blow past the ceiling is refused up front.
  assertRefused(
    () => rewriteClaudeSession(big, { fromCwd: "xx", toCwd: "y".repeat(4000) }),
    "session_rewrite_too_large",
  );
  // A realistic cwd/worktree pair is nowhere near the ceiling.
  assert.doesNotThrow(() => rewriteClaudeSession(big, { fromCwd: FROM_CWD, toCwd: TO_CWD }));
});
