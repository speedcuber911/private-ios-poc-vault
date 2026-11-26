// Google Antigravity CLI (`agy`) adapter.
//
// Headless runs use `--input-format stream-json --output-format stream-json`
// driven by `antigravity-job-runner.mjs` (never `-p`/`--print` alongside
// `--input-format stream-json`).

import { cleanApiText } from "../util.mjs";

function buildAntigravityArgs(job = {}, { transport = "stream", dangerousMode = true } = {}) {
  const args = [];
  if (transport === "print") {
    args.push("--print", job.codexPrompt || job.prompt || "", "--output-format", "stream-json");
  } else {
    args.push("--input-format", "stream-json", "--output-format", "stream-json");
  }
  args.push("--disable-slash-commands");
  if (dangerousMode) args.push("--dangerously-skip-permissions");
  if (job.model) args.push("--model", job.model);
  if (job.reasoningEffort) args.push("--effort", job.reasoningEffort);
  if (job.resumeSessionId) args.push("--conversation", job.resumeSessionId);
  return args;
}

// Parses `agy models` output (`<slug>   <Display Name>`).
// Real `agy models` emits spinner frames separated by `\r` (without newlines)
// before the first model row, so split on both `\r` and `\n` after stripping
// ANSI/control characters.
function parseAntigravityModelsOutput(text) {
  const cleaned = cleanApiText(text);
  const seen = new Set();
  const models = [];
  for (const rawLine of cleaned.split(/[\r\n]+/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([a-z0-9][a-z0-9._:-]*)\s{2,}(.+)$/i.exec(line);
    if (!match) continue;
    const slug = match[1].trim();
    const label = match[2].trim();
    if (!slug || slug.endsWith(":") || slug.length > 180 || !label || seen.has(slug)) continue;
    seen.add(slug);
    models.push({ slug, label });
  }
  return models;
}

export {
  buildAntigravityArgs,
  parseAntigravityModelsOutput,
};
