// Codex prints these on every process start when leftover
// `$CODEX_HOME/tmp/arg0` dirs are locked or owned by another uid. They are not
// about the user's prompt and used to light up the phone run card as a warning.

export function isCodexHarnessNoise(line) {
  const text = String(line || "");
  if (/failed to clean up stale(?: arg0)? temp dirs/i.test(text)) return true;
  if (/could not create PATH aliases/i.test(text)) return true;
  return false;
}

export function stripCodexHarnessNoise(text) {
  const value = String(text ?? "");
  if (!value) return value;
  return value
    .split(/(?<=\n)/)
    .filter((part) => !isCodexHarnessNoise(part))
    .join("");
}
