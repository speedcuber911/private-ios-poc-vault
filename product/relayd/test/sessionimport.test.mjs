import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { importSession, rewriteClaudeSession, claudeProjectSlug, summaryPrompt, assertContained } =
  await import("../src/sessionimport.mjs");

const FROM_CWD = "/Users/dev/code/relay";
const TO_CWD = "/srv/relay-workspaces/handoff-abc123";

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

  const staged = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD),
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.ok(fs.existsSync(staged), "the session file is staged for resume");
  assert.equal(JSON.parse(fs.readFileSync(staged, "utf8").trim()).cwd, TO_CWD);
  assert.deepEqual(
    { provider: result.provider, resumeSessionId: result.resumeSessionId },
    { provider: "claude", resumeSessionId: "11111111-2222-4333-8444-555555555555" },
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

test("rewriteClaudeSession treats a $-bearing toCwd as a literal replacement, not a replace-pattern", () => {
  // String.prototype.replace gives $&, $`, $', $1... special meaning in a
  // *string* replacement (insert the match / pre-match / post-match / a
  // capture group). rewriteClaudeSession must never interpret toCwd that
  // way: toCwd is remote-supplied (built from an untrusted handoff id) and
  // a $&-bearing value would re-inject the laptop path it was supposed to
  // redact, while $`/$' silently splice in huge surrounding substrings.
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

test("staged session files are private to the runner", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });
  const staged = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD),
    "11111111-2222-4333-8444-555555555555.jsonl");
  assert.equal(fs.statSync(staged).mode & 0o777, 0o600);
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

test("importSession rejects a sessionId that path-traverses outside runHome (claude branch)", () => {
  const { runHome, codexHome } = homes();
  // Per-test canary directory (not a shared global path) so this test is not
  // order- or environment-dependent, and so the assertion below checks the
  // exact path the code would actually write to: `${sessionId}.jsonl`, not
  // a bare guess at the traversal target.
  const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-canary-"));
  const evilId = "../".repeat(20) + canaryDir.replace(/^\//, "") + "/RELAYD-PWNED-DEMO";
  const evilTarget = path.join(canaryDir, "RELAYD-PWNED-DEMO.jsonl");
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");

  assert.throws(
    () => importSession({
      manifest: manifest({ sessionId: evilId }),
      sessionBytes, runHome, codexHome, worktreePath: TO_CWD,
    }),
    /unsafe_session_id/,
  );
  assert.ok(!fs.existsSync(evilTarget), "no file escapes the jail");
});

test("importSession rejects a sessionId that path-traverses outside codexHome (codex branch)", () => {
  const { runHome, codexHome } = homes();
  const canaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-canary-"));
  const evilId = "../".repeat(20) + canaryDir.replace(/^\//, "") + "/RELAYD-PWNED-DEMO-CODEX";
  const evilTarget = path.join(canaryDir, "RELAYD-PWNED-DEMO-CODEX.jsonl");
  const rollout = Buffer.from(`${JSON.stringify({ record: "rollout", cwd: FROM_CWD })}\n`, "utf8");

  assert.throws(
    () => importSession({
      manifest: manifest({ harness: "codex", sessionFormat: "codex-rollout", sessionId: evilId }),
      sessionBytes: rollout, runHome, codexHome, worktreePath: TO_CWD,
    }),
    /unsafe_session_id/,
  );
  assert.ok(!fs.existsSync(evilTarget), "no file escapes the jail");
});

test("importSession rejects an absolute-path sessionId", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  assert.throws(
    () => importSession({
      manifest: manifest({ sessionId: "/etc/RELAYD-PWNED-ABS" }),
      sessionBytes, runHome, codexHome, worktreePath: TO_CWD,
    }),
    /unsafe_session_id/,
  );
  assert.ok(!fs.existsSync("/etc/RELAYD-PWNED-ABS"), "no file escapes the jail");
});

test("importSession rejects a sessionId containing a forward slash", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  assert.throws(
    () => importSession({
      manifest: manifest({ sessionId: "abc/def" }),
      sessionBytes, runHome, codexHome, worktreePath: TO_CWD,
    }),
    /unsafe_session_id/,
  );
});

test("importSession rejects a sessionId that is exactly '..'", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  assert.throws(
    () => importSession({
      manifest: manifest({ sessionId: ".." }),
      sessionBytes, runHome, codexHome, worktreePath: TO_CWD,
    }),
    /unsafe_session_id/,
  );
});

test("assertContained rejects a sibling directory that merely shares a prefix", () => {
  // Deleting assertContained's throw leaves every other test green, because
  // the sessionId allow-list catches every reachable attack before this
  // second layer is ever consulted. Exercise it directly so there is proof
  // the layer itself works, independent of what currently reaches it.
  assert.throws(() => assertContained("/srv/relay", "/srv/relay-evil/x"), /unsafe_session_id/);
  assert.throws(() => assertContained("/srv/relay", "/srv/relayevil"), /unsafe_session_id/);
});

test("assertContained accepts a genuine child path", () => {
  assert.doesNotThrow(() => assertContained("/srv/relay", "/srv/relay/x"));
  assert.doesNotThrow(() => assertContained("/srv/relay", "/srv/relay"));
});

test("importSession refuses to follow a pre-planted symlink at the leaf session file (claude branch)", () => {
  // The jailed agent owns its own HOME and the attacker supplies a
  // perfectly legitimate sessionId (a real UUID, no traversal needed): it
  // can pre-plant the leaf `<uuid>.jsonl` as a symlink pointing anywhere on
  // disk. mkdirSync/writeFileSync would happily follow it and clobber
  // whatever it points at.
  const { runHome, codexHome } = homes();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-outside-"));
  const outsideFile = path.join(outsideDir, "CLOBBER-ME.txt");
  fs.writeFileSync(outsideFile, "original contents\n");

  const sessionId = "33333333-4444-4444-8444-555555555555";
  const projectDir = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD));
  fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(outsideFile, path.join(projectDir, `${sessionId}.jsonl`));

  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");

  assert.throws(() => importSession({
    manifest: manifest({ sessionId }),
    sessionBytes, runHome, codexHome, worktreePath: TO_CWD,
  }));
  assert.equal(fs.readFileSync(outsideFile, "utf8"), "original contents\n",
    "the symlink target outside the jail must not be modified");
});

test("importSession refuses to follow a symlinked project directory out of the jail (claude branch)", () => {
  const { runHome, codexHome } = homes();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-outside-"));
  const canaryFile = path.join(outsideDir, "CANARY.txt");
  fs.writeFileSync(canaryFile, "do not touch\n");

  const sessionId = "44444444-5555-4444-8444-555555555555";
  const projectDir = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD));
  fs.mkdirSync(path.dirname(projectDir), { recursive: true, mode: 0o700 });
  // The project directory itself (not just the leaf) is a symlink escaping
  // the jail — this is a level assertContained's purely lexical check
  // cannot see, since path.resolve never touches the filesystem.
  fs.symlinkSync(outsideDir, projectDir);

  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");

  assert.throws(() => importSession({
    manifest: manifest({ sessionId }),
    sessionBytes, runHome, codexHome, worktreePath: TO_CWD,
  }));
  assert.equal(fs.readFileSync(canaryFile, "utf8"), "do not touch\n",
    "the canary outside the jail must not be modified");
  assert.ok(!fs.existsSync(path.join(outsideDir, `${sessionId}.jsonl`)),
    "no session file was written outside the jail");
});

test("importSession refuses to follow a symlinked sessions directory out of the jail (codex branch)", () => {
  const { runHome, codexHome } = homes();
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-outside-"));
  const canaryFile = path.join(outsideDir, "CANARY.txt");
  fs.writeFileSync(canaryFile, "do not touch\n");

  const sessionId = "55555555-6666-4444-8444-555555555555";
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  fs.symlinkSync(outsideDir, path.join(codexHome, "sessions"));

  const rollout = Buffer.from(`${JSON.stringify({ record: "rollout", cwd: FROM_CWD })}\n`, "utf8");

  assert.throws(() => importSession({
    manifest: manifest({ harness: "codex", sessionFormat: "codex-rollout", sessionId }),
    sessionBytes: rollout, runHome, codexHome, worktreePath: TO_CWD,
  }));
  assert.equal(fs.readFileSync(canaryFile, "utf8"), "do not touch\n",
    "the canary outside the jail must not be modified");
  assert.ok(!fs.existsSync(path.join(outsideDir, `${sessionId}.jsonl`)),
    "no session file was written outside the jail");
});

test("rewriteClaudeSession does not corrupt sibling paths that share a prefix", () => {
  const text = JSON.stringify({
    old: `${FROM_CWD}-old`,
    ground: `${FROM_CWD}ground`,
    exact: FROM_CWD,
  });
  const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  const parsed = JSON.parse(rewritten);

  assert.equal(parsed.old, `${FROM_CWD}-old`, "sibling with a dash suffix must be left alone");
  assert.equal(parsed.ground, `${FROM_CWD}ground`, "sibling with a continuation suffix must be left alone");
  assert.equal(parsed.exact, TO_CWD, "an exact match must still be rewritten");
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

test("rewriteClaudeSession does not corrupt siblings that share a prefix but differ by punctuation", () => {
  // [A-Za-z0-9._-] under-blocks: none of +, ~, space-then-digit's paren, or
  // @ are in that class, so the old negative-lookahead let these siblings
  // through and corrupted them. This is the original bug class surviving.
  const siblings = [
    `${FROM_CWD}+plus`,
    `${FROM_CWD}~1`,
    `${FROM_CWD}(copy)`,
    `${FROM_CWD}@2`,
  ];
  for (const sibling of siblings) {
    const text = JSON.stringify({ path: sibling });
    const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
    assert.equal(JSON.parse(rewritten).path, sibling, `sibling must survive untouched: ${sibling}`);
  }
});

test("rewriteClaudeSession still rewrites a cwd immediately followed by sentence-ending punctuation", () => {
  // Over-block: "." was in the old blocklist, so a cwd followed directly by
  // a trailing period (ordinary prose, not a path continuation) was never
  // rewritten, leaking the laptop path.
  const text = `working in ${FROM_CWD}.`;
  const rewritten = rewriteClaudeSession(text, { fromCwd: FROM_CWD, toCwd: TO_CWD });
  assert.equal(rewritten, `working in ${TO_CWD}.`);
  assert.ok(!rewritten.includes(FROM_CWD), "no laptop path should survive the rewrite");
});

test("staged directories (not just the leaf file) are 0700", () => {
  const { runHome, codexHome } = homes();
  const sessionBytes = Buffer.from(`${JSON.stringify({ type: "user", cwd: FROM_CWD })}\n`, "utf8");
  importSession({ manifest: manifest(), sessionBytes, runHome, codexHome, worktreePath: TO_CWD });

  const projectDir = path.join(runHome, ".claude", "projects", claudeProjectSlug(TO_CWD));
  let dir = projectDir;
  while (dir.startsWith(runHome) && dir !== runHome) {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700, `${dir} must be 0700`);
    dir = path.dirname(dir);
  }
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
