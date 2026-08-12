// relayd sessionimport.mjs — stage a handed-off session so the harness's own
// resume mechanism continues the conversation on this node.
//
// Claude Code keys sessions by the absolute working directory, so its transcript
// is rewritten from the laptop path to the sandbox checkout. Codex replays a
// rollout by id and needs no rewriting. Cursor has no portable session file, so
// it takes the primed-prompt path — stated plainly rather than faked.
import fs from "node:fs";
import path from "node:path";

const HANDOFF_MANIFEST_VERSION = 1;

// Claude session ids are UUIDs; Codex rollout ids are hex-ish. Both fit this
// shared allow-list. manifest.sessionId crossed a machine boundary, so it is
// untrusted input — reject anything that isn't a plain, single-segment token
// before it ever touches a filesystem path.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function assertSafeSessionId(sessionId) {
  if (
    typeof sessionId !== "string" ||
    sessionId === ".." ||
    sessionId.includes("..") ||
    sessionId.includes("/") ||
    sessionId.includes("\\") ||
    !SAFE_SESSION_ID.test(sessionId)
  ) {
    throw new Error(`unsafe_session_id: ${JSON.stringify(sessionId)}`);
  }
  return sessionId;
}

// First layer of defense: even after validating the id, confirm the resolved
// file actually lands inside the intended base directory before writing.
// Compare against `base + path.sep` rather than a bare startsWith(base), so a
// sibling directory that merely shares a prefix (e.g. base "/srv/relay" vs
// "/srv/relay-evil") cannot pass the check. This is purely lexical
// (path.resolve never touches the filesystem) — see writeContainedFile below
// for the symlink-aware second layer that a lexical check alone can't provide.
// Exported so this layer has a direct test, independent of whatever
// (currently) reaches it through importSession.
function assertContained(baseDir, filePath) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedFile = path.resolve(filePath);
  if (resolvedFile !== resolvedBase && !resolvedFile.startsWith(resolvedBase + path.sep)) {
    throw new Error(`unsafe_session_id: resolved path escapes base directory`);
  }
  return resolvedFile;
}

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function rewriteClaudeSession(text, { fromCwd, toCwd }) {
  if (!fromCwd || fromCwd === toCwd) return text;
  // Boundary-aware: only substitute when the match is followed by a real
  // path/word boundary — a path separator, a quote, a backslash (an
  // embedded quote inside a JSON string value is serialized as `\"`, so the
  // character right after the cwd is the escaping backslash, not the quote
  // itself), whitespace, or end-of-string (optionally through one trailing
  // period, so ordinary prose like "...in /path/to/relay." still gets
  // rewritten instead of leaking the laptop path) — so a sibling that
  // merely shares a prefix ("relay+plus", "relay~1", "relay(copy)",
  // "relay@2", "relay-old") is left untouched instead of silently corrupted.
  const escaped = fromCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = String.raw`(?=[/"'\\\s]|\.?$)`;
  // The replacement is a function, not a string: String.prototype.replace
  // gives $&, $\`, $', $1... special meaning in a *string* replacement, so a
  // toCwd containing one of those sequences would get reinterpreted instead
  // of inserted literally — toCwd is built from a remote-supplied handoff
  // id, so this is reachable, not theoretical. A function replacement is
  // always used as-is.
  return text.replace(new RegExp(`${escaped}${boundary}`, "g"), () => toCwd);
}

// Second layer of defense: mkdirSync/writeFileSync follow symlinks, so a
// symlinked ancestor anywhere between jailRoot and the leaf — or the leaf
// itself — can silently redirect a write outside the intended directory even
// though assertContained's lexical check above passed. After creating the
// directory, compare the REAL (symlink-resolved) directory against the REAL
// (symlink-resolved) jail root; only if it still nests inside does the write
// proceed. Finally, open the leaf ourselves with O_NOFOLLOW so a pre-planted
// symlink at the leaf position fails closed instead of being followed (and
// potentially clobbering whatever it points at).
function writeContainedFile({ jailRoot, dir, target, contents }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const resolvedRoot = fs.realpathSync(jailRoot);
  const resolvedDir = fs.realpathSync(dir);
  if (resolvedDir !== resolvedRoot && !resolvedDir.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`unsafe_session_id: resolved directory escapes jail via symlink`);
  }

  let fd;
  try {
    fd = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
      0o600,
    );
  } catch (err) {
    if (err.code === "ELOOP") {
      throw new Error(`unsafe_session_id: refusing to follow a symlink at the session file path`);
    }
    throw err;
  }
  try {
    fs.writeFileSync(fd, contents);
  } finally {
    fs.closeSync(fd);
  }
}

function summaryPrompt(manifest) {
  const title = manifest.title || "an untitled session";
  const repo = manifest.repo || "an unknown repo";
  const branch = manifest.branch || "an unknown branch";
  const lines = [
    `Continue this handed-off session: ${title}`,
    "",
    `It was running on ${manifest.machine || "another machine"} in ${repo}, on branch ${branch}.`,
  ];
  if (manifest.wip?.summary) lines.push(`Uncommitted work carried over: ${manifest.wip.summary}.`);
  if (manifest.excerpt) lines.push("", "Where it left off:", manifest.excerpt);
  lines.push("", "Pick up from there. The working tree already contains that work.");
  return lines.join("\n");
}

function importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath }) {
  // An unrecognized harness deliberately degrades to the claude branch (it's
  // the most conservative resume path — a primed prompt with no session
  // file). requestedHarness keeps that degradation observable instead of
  // silent, so callers/logs can tell what was actually asked for.
  const requestedHarness = manifest.harness;
  const provider = manifest.harness === "codex" || manifest.harness === "cursor" ? manifest.harness : "claude";

  if (sessionBytes && manifest.sessionFormat === "claude-jsonl" && manifest.sessionId) {
    assertSafeSessionId(manifest.sessionId);
    const rewritten = rewriteClaudeSession(sessionBytes.toString("utf8"), {
      fromCwd: manifest.cwd,
      toCwd: worktreePath,
    });
    // The base passed to assertContained is the actual write directory
    // (projectDir), not the wider runHome: runHome would still permit
    // escaping into home/.claude/settings.local.jsonl, an unrelated file in
    // home directly, or — worst — a sibling workspace's transcript
    // directory (transcript poisoning).
    const projectDir = path.join(runHome, ".claude", "projects", claudeProjectSlug(worktreePath));
    const target = assertContained(projectDir, path.join(projectDir, `${manifest.sessionId}.jsonl`));
    writeContainedFile({ jailRoot: runHome, dir: projectDir, target, contents: rewritten });
    return { provider: "claude", requestedHarness, resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  if (sessionBytes && manifest.sessionFormat === "codex-rollout" && manifest.sessionId) {
    assertSafeSessionId(manifest.sessionId);
    const sessionsDir = path.join(codexHome, "sessions");
    const target = assertContained(sessionsDir, path.join(sessionsDir, `${manifest.sessionId}.jsonl`));
    writeContainedFile({ jailRoot: codexHome, dir: sessionsDir, target, contents: sessionBytes });
    return { provider: "codex", requestedHarness, resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  return { provider, requestedHarness, resumeSessionId: null, primedPrompt: summaryPrompt(manifest) };
}

export {
  HANDOFF_MANIFEST_VERSION,
  assertContained,
  claudeProjectSlug,
  rewriteClaudeSession,
  summaryPrompt,
  importSession,
};
