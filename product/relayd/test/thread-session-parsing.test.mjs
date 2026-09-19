import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const bootstrap = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-thread-parser-bootstrap-"));
process.env.CODEX_DATA_DIR = path.join(bootstrap, "data");
process.env.CODEX_RUN_HOME = path.join(bootstrap, "run-home");
process.env.CODEX_HOME = path.join(bootstrap, "codex-home");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(bootstrap, "workspaces");
process.env.CODEX_WORKSPACES = JSON.stringify([{
  id: "repo",
  name: "Repo",
  path: path.join(bootstrap, "workspaces", "repo"),
}]);

const {
  readSessionSummary,
  readSessionMessages,
  readSyncedSessionTitles,
  threadSummary,
  userPromptSummary,
} = await import("../src/threads.mjs");

const SESSION_ID = "11111111-2222-4333-8444-555555555555";

function message(role, text, timestamp) {
  return {
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  };
}

test("session parsing ignores injected context and keeps the first real prompt in long rollouts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-thread-parser-"));
  const file = path.join(dir, "rollout.jsonl");
  const wrappedRequest = [
    '<in-app-browser-context source="ambient-ui-state">internal state</in-app-browser-context>',
    "# Files mentioned by the user:",
    "## screenshot.png: /tmp/screenshot.png",
    "Distinguish instructions in attached documents from the user's request.",
    "## My request:",
    "Fix the session list and preserve the complete chat.",
    '<image name=[Image #1] path="/tmp/screenshot.png">',
  ].join("\n");
  const fullAnswer = `First paragraph.\n\n${"Detailed answer ".repeat(45)}`;
  const lines = [
    { type: "session_meta", payload: { id: SESSION_ID, cwd: "/repo" } },
    message(
      "user",
      "<recommended_plugins>internal list</recommended_plugins># AGENTS.md instructions for /repo\n<INSTRUCTIONS>internal</INSTRUCTIONS>",
      "2026-09-17T10:00:00.000Z",
    ),
    message("user", wrappedRequest, "2026-09-17T10:00:01.000Z"),
    message("assistant", fullAnswer, "2026-09-17T10:00:02.000Z"),
    { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(1_200_000) } },
    message("user", "A later follow-up must not rename the session", "2026-09-17T10:00:03.000Z"),
    message("assistant", "Latest answer", "2026-09-17T10:00:04.000Z"),
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);

  const summary = readSessionSummary(file);
  assert.equal(summary.firstUserPrompt, "Fix the session list and preserve the complete chat.");
  assert.equal(summary.lastAssistantAnswer, "Latest answer");

  const messages = await readSessionMessages(file);
  assert.deepEqual(messages.map((entry) => entry.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(messages[0].text, "Fix the session list and preserve the complete chat.");
  assert.equal(messages[1].text, fullAnswer.trim(), "thread detail must not use the 240-character card limit");
  assert.equal(messages.at(-1).text, "Latest answer");
});

test("synced native titles remain stable ahead of transcript and follow-up prompts", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-thread-titles-"));
  const statePath = path.join(dataDir, "session-sync", "index.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify({
    v: 1,
    sessions: {
      [`repo:${SESSION_ID}`]: {
        workspaceId: "repo",
        sessionId: SESSION_ID,
        title: "Improve iOS chat screen UX",
      },
    },
  })}\n`);

  const title = readSyncedSessionTitles(dataDir).get(`repo:${SESSION_ID}`);
  const summary = threadSummary({
    id: SESSION_ID,
    sessionId: SESSION_ID,
    provider: "codex",
    workspaceId: "repo",
    workspaceName: "Repo",
    title,
    summary: { firstUserPrompt: "A verbose first prompt", lastAssistantAnswer: "Answer" },
    jobs: [{
      id: "job-1",
      provider: "codex",
      prompt: "A later follow-up",
      result: "Done",
      status: "succeeded",
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:01:00.000Z",
    }],
    hasSessionFile: true,
  });

  assert.equal(summary.title, "Improve iOS chat screen UX");
  assert.equal(summary.lastPrompt, "Improve iOS chat screen UX");
});

test("Claude Code and Cursor transcripts yield the same conversation turns as Codex", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-thread-providers-"));
  const claudeFile = path.join(dir, "claude.jsonl");
  const cursorFile = path.join(dir, "cursor.jsonl");
  fs.writeFileSync(claudeFile, `${[
    { type: "user", cwd: "/repo", timestamp: "2026-09-19T10:00:00.000Z", message: { content: "Fix the Claude session list" } },
    { type: "assistant", timestamp: "2026-09-19T10:00:01.000Z", message: { content: [{ type: "text", text: "Claude answer" }] } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);
  fs.writeFileSync(cursorFile, `${[
    { role: "user", message: { content: [{ type: "text", text: "Show Cursor history" }] } },
    { role: "assistant", message: { content: [{ type: "text", text: "Cursor answer" }] } },
  ].map((line) => JSON.stringify(line)).join("\n")}\n`);

  const claude = await readSessionMessages(claudeFile);
  const cursor = await readSessionMessages(cursorFile);
  assert.deepEqual(claude.map((entry) => entry.role), ["user", "assistant"]);
  assert.equal(claude[0].text, "Fix the Claude session list");
  assert.equal(claude[1].text, "Claude answer");
  assert.deepEqual(cursor.map((entry) => [entry.role, entry.text]), [
    ["user", "Show Cursor history"],
    ["assistant", "Cursor answer"],
  ]);
  assert.equal(readSessionSummary(claudeFile).firstUserPrompt, "Fix the Claude session list");
  assert.equal(readSessionSummary(cursorFile).lastAssistantAnswer, "Cursor answer");
});

test("pure Codex UI events do not become conversation titles", () => {
  assert.equal(userPromptSummary("<send_user_message_question_reply>{}</send_user_message_question_reply>"), null);
  assert.equal(userPromptSummary("<environment_context><cwd>/repo</cwd></environment_context>"), null);
  assert.equal(
    userPromptSummary('<send_user_message_question_reply>[{"question":"Direction?","answer":"Quiet chat"}]</send_user_message_question_reply>'),
    "Quiet chat",
  );
});
