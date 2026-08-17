// Kimi Code CLI adapter. Relay runs Kimi K3 through the user's direct Kimi
// subscription in the isolated runner home, matching the other CLI providers.

import { cleanApiText } from "../util.mjs";
import { isKimiSessionId } from "../sessionid.mjs";

const defaultKimiModel = "kimi-code/k3";

function buildKimiArgs(job) {
  const args = [];
  if (job.resumeSessionId) args.push("--session", job.resumeSessionId);
  args.push("--model", job.model || defaultKimiModel);
  args.push("--prompt", job.codexPrompt || job.prompt, "--output-format", "stream-json");
  return args;
}

function contentText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  if (typeof value.text === "string") return value.text;
  if (value.content !== undefined) return contentText(value.content);
  return "";
}

function parseKimiResult(value) {
  let result = "";
  let sessionId = null;
  for (const line of cleanApiText(value).split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const candidateSessionId = entry?.sessionId || entry?.session_id || entry?.session?.id;
    if (isKimiSessionId(candidateSessionId)) sessionId = candidateSessionId;

    const message = entry?.message && typeof entry.message === "object" ? entry.message : entry;
    const role = String(message?.role || message?.type || "").toLowerCase();
    if (role !== "assistant") continue;
    const text = contentText(message.content ?? message.text).trim();
    if (text) result = text;
  }
  return { result, sessionId };
}

export {
  defaultKimiModel,
  buildKimiArgs,
  parseKimiResult,
};
