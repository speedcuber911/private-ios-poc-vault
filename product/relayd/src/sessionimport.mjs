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

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function rewriteClaudeSession(text, { fromCwd, toCwd }) {
  if (!fromCwd || fromCwd === toCwd) return text;
  return text.split(fromCwd).join(toCwd);
}

function writePrivateFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
}

function summaryPrompt(manifest) {
  const lines = [
    `Continue this handed-off session: ${manifest.title}`,
    "",
    `It was running on ${manifest.machine || "another machine"} in ${manifest.repo}, on branch ${manifest.branch}.`,
  ];
  if (manifest.wip?.summary) lines.push(`Uncommitted work carried over: ${manifest.wip.summary}.`);
  if (manifest.excerpt) lines.push("", "Where it left off:", manifest.excerpt);
  lines.push("", "Pick up from there. The working tree already contains that work.");
  return lines.join("\n");
}

function importSession({ manifest, sessionBytes, runHome, codexHome, worktreePath }) {
  const provider = manifest.harness === "codex" || manifest.harness === "cursor" ? manifest.harness : "claude";

  if (sessionBytes && manifest.sessionFormat === "claude-jsonl" && manifest.sessionId) {
    const rewritten = rewriteClaudeSession(sessionBytes.toString("utf8"), {
      fromCwd: manifest.cwd,
      toCwd: worktreePath,
    });
    writePrivateFile(
      path.join(runHome, ".claude", "projects", claudeProjectSlug(worktreePath), `${manifest.sessionId}.jsonl`),
      rewritten,
    );
    return { provider: "claude", resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  if (sessionBytes && manifest.sessionFormat === "codex-rollout" && manifest.sessionId) {
    writePrivateFile(path.join(codexHome, "sessions", `${manifest.sessionId}.jsonl`), sessionBytes);
    return { provider: "codex", resumeSessionId: manifest.sessionId, primedPrompt: null };
  }

  return { provider, resumeSessionId: null, primedPrompt: summaryPrompt(manifest) };
}

export {
  HANDOFF_MANIFEST_VERSION,
  claudeProjectSlug,
  rewriteClaudeSession,
  summaryPrompt,
  importSession,
};
