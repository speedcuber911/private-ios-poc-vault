// Normalize only usage the provider actually reports. Aggregate turn token
// totals are billing counters, not the occupancy of a context window.
const finite = (value) => Number.isFinite(value) && value >= 0;
const percent = (value) => finite(value) ? Math.min(100, value) : undefined;
const date = (seconds) => {
  if (!finite(seconds)) return undefined;
  const value = new Date(seconds * 1000);
  return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
};
const compact = (value) => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

export function codexPlanUsage(snapshot, reportedAt) {
  if (!snapshot || typeof snapshot !== "object") return [];
  return ["primary", "secondary"].flatMap((key) => {
    const window = snapshot[key];
    if (!window || typeof window !== "object") return [];
    return [compact({
      id: `${snapshot.limitId || "codex"}:${key}`,
      name: snapshot.limitName || undefined,
      windowMinutes: finite(window.windowDurationMins) ? window.windowDurationMins : undefined,
      usedPercent: percent(window.usedPercent), resetsAt: date(window.resetsAt), reportedAt,
    })];
  });
}

export function claudePlanUsage(info, reportedAt) {
  if (!info || typeof info !== "object" || typeof info.rateLimitType !== "string") return [];
  const names = { five_hour: "Current session", seven_day: "All models", seven_day_opus: "Opus", seven_day_sonnet: "Sonnet", seven_day_overage_included: "Included extra usage", overage: "Extra usage" };
  return [compact({
    id: info.rateLimitType, name: names[info.rateLimitType] || "Plan limit",
    windowMinutes: info.rateLimitType === "five_hour" ? 300 : info.rateLimitType.startsWith("seven_day") ? 10080 : undefined,
    // SDK RateLimitInfo.utilization is a fraction, unlike Codex.usedPercent.
    usedPercent: finite(info.utilization) ? percent(info.utilization * 100) : undefined,
    resetsAt: date(info.resetsAt), reportedAt,
    status: ["allowed", "allowed_warning", "rejected"].includes(info.status) ? info.status : undefined,
  })];
}

export function claudeContext(message) {
  const usage = message?.usage;
  if (!usage || !finite(usage.input_tokens)) return null;
  const count = (value) => finite(value) ? value : 0;
  return {
    model: message.model,
    input: usage.input_tokens + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
    output: count(usage.output_tokens),
  };
}
