import test from "node:test";
import assert from "node:assert/strict";
import { createClaudeStreamMapper } from "../src/timeline-claude.mjs";
import { createCodexNotificationMapper } from "../src/timeline-codex.mjs";

const now = () => "2026-10-21T10:00:00.000Z";

test("Codex context uses the latest request, not cumulative thread tokens, and ignores subagents", () => {
  const mapper = createCodexNotificationMapper({ now });
  mapper.push({ method: "turn/started", params: { threadId: "main" } });
  const update = (threadId, input, total) => mapper.push({ method: "thread/tokenUsage/updated", params: {
    threadId, tokenUsage: { modelContextWindow: 200000, last: { inputTokens: input, outputTokens: 100, totalTokens: input + 100 }, total: { totalTokens: total } },
  } });
  update("main", 80000, 500000);
  assert.deepEqual(update("sub", 180000, 700000), []);
  const events = update("main", 6000, 506100);
  assert.equal(events.at(-1).contextTokens, 6100);
  assert.equal(events.at(-1).contextWindow, 200000);
  assert.equal(events.at(-1).contextReportedAt, now());
});

test("Codex plan limits preserve actual windows, zero, and missing percentages", () => {
  const mapper = createCodexNotificationMapper({ now });
  const [event] = mapper.push({ method: "account/rateLimits/updated", params: { rateLimits: {
    limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1792600000 },
    secondary: { windowDurationMins: 10080 },
  } } });
  assert.equal(event.limits[0].usedPercent, 0);
  assert.equal(event.limits[0].windowMinutes, 300);
  assert.equal(event.limits[1].usedPercent, undefined);
  assert.equal(event.limits[1].windowMinutes, 10080);
});

test("Claude context follows the final top-level model request, including cache, without summing requests", () => {
  const mapper = createClaudeStreamMapper({ now });
  const message = (model, tokens, parent) => mapper.push({ type: "assistant", parent_tool_use_id: parent,
    message: { model, usage: { input_tokens: tokens, cache_read_input_tokens: 5000, cache_creation_input_tokens: 1000, output_tokens: 100 }, content: [] } });
  message("first", 100000);
  message("final", 2000);
  message("child", 180000, "nested");
  const [event] = mapper.push({ type: "result", usage: { input_tokens: 282000, output_tokens: 300 },
    modelUsage: { first: { contextWindow: 1000000 }, final: { contextWindow: 200000 }, child: { contextWindow: 1000000 } } });
  assert.equal(event.inputTokens, 282000);
  assert.equal(event.contextTokens, 8100);
  assert.equal(event.contextWindow, 200000);
  assert.equal(event.contextReportedAt, now());
});

test("Claude partial messages track the latest request when no assistant snapshot arrives", () => {
  const mapper = createClaudeStreamMapper({ now });
  mapper.push({ type: "stream_event", event: { type: "message_start", message: { model: "test", usage: { input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 0 } } } });
  mapper.push({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 50 } } });
  const [event] = mapper.push({ type: "result", usage: { input_tokens: 100, output_tokens: 50 }, modelUsage: { test: { contextWindow: 200000 } } });
  assert.equal(event.contextTokens, 1050);
});

test("Claude rate limits convert documented fractions and keep unavailable distinct from zero", () => {
  const mapper = createClaudeStreamMapper({ now });
  const rate = (info) => mapper.push({ type: "rate_limit_event", rate_limit_info: info })[0];
  assert.equal(rate({ rateLimitType: "five_hour", utilization: 0.86, status: "allowed_warning" }).limits[0].usedPercent, 86);
  const missing = rate({ rateLimitType: "seven_day", status: "allowed", resetsAt: 1792600000 }).limits[0];
  assert.equal(missing.usedPercent, undefined);
  assert.equal(missing.resetsAt, "2026-10-21T16:26:40.000Z");
  assert.equal(missing.status, "allowed");
});

test("Aggregate Claude usage alone never fabricates context occupancy", () => {
  const mapper = createClaudeStreamMapper({ now });
  const [event] = mapper.push({ type: "result", usage: { input_tokens: 500000, output_tokens: 1000 }, modelUsage: { test: { contextWindow: 200000 } } });
  assert.equal(event.contextTokens, undefined);
  assert.equal(event.contextWindow, undefined);
});
