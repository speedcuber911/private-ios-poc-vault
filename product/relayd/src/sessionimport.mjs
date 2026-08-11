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

// Second layer of defense: even after validating the id, confirm the resolved
// file actually lands inside the intended base directory before writing.
// Compare against `base + path.sep` rather than a bare startsWith(base), so a
// sibling directory that merely shares a prefix (e.g. base "/srv/relay" vs
// "/srv/relay-evil") cannot pass the check.
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
  // Boundary-aware: only substitute when the match is not immediately
  // followed by a filename-continuation character, so a sibling directory
  // that shares a prefix (e.g. "relay-old" or "relayground" next to "relay")
  // is left untouched instead of silently corrupted.
  const escaped = fromCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`${escaped}(?![A-Za-z0-9._-])`, "g"), toCwd);
}

function writePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

function summaryPrompt(manifest) {
  const repo = manifest.repo || "an unknown repo";
  const branch = manifest.branch || "an unknown branch";
  const lines = [
    `Continue this handed-off session: ${manifest.title}`,
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
    const projectDir = path.join(runHome, ".claude", "projects", claudeProjectSlug(worktreePath));
    const target = assertContained(runHome, path.join(projectDir, `${manifest.sessionId}.jsonl`));
    writePrivateFile(target, rewritten);
    return { provider: "claude", requestedHarness, resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  if (sessionBytes && manifest.sessionFormat === "codex-rollout" && manifest.sessionId) {
    assertSafeSessionId(manifest.sessionId);
    const target = assertContained(codexHome, path.join(codexHome, "sessions", `${manifest.sessionId}.jsonl`));
    writePrivateFile(target, sessionBytes);
    return { provider: "codex", requestedHarness, resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  return { provider, requestedHarness, resumeSessionId: null, primedPrompt: summaryPrompt(manifest) };
}

export {
  HANDOFF_MANIFEST_VERSION,
  claudeProjectSlug,
  rewriteClaudeSession,
  summaryPrompt,
  importSession,
};
