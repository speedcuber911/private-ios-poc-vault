# Chat composer and transcript rework

Date: 2026-10-06. Status: in progress on `relay/chat-revamp`.

## Why

The owner compared Relay's chat with the Claude iOS app and called Relay's
"not usable": model selection, the mic, scrolling, and the fact that a running
turn shows no reasoning, no tool steps and no sub-agents.

Two causes, one visible and one not:

1. **The composer** has five unlike controls in one row, hides effort and
   permissions behind a sliders icon, opens a full-screen model list, and
   inserts a row above the text field when dictation starts.
2. **The machine never captures what the agent does.** `relayd` runs Claude Code
   as `claude --print` with no output format, so nothing reaches the phone until
   the job exits, and then only the final text. Codex prints `[relay-step]`
   lines to stderr and mixes command output with answer text on stdout. Thread
   history drops every tool and thinking block. There is no structured event
   anywhere, so the phone has nothing to render.

This spec covers both. The composer design is approved (canvas:
<https://claude.ai/artifact/BZywfX4v4P1rs36jbkVVyK>). The transcript design
follows the Claude app's structure in Relay's Editorial Ember skin.

## Part 1: the timeline contract (machine to phone)

A **timeline** is the ordered record of one job: prose the agent wrote, and the
steps it took. It is additive. An old phone ignores it; a new phone falls back
to today's job card when a machine does not send it.

### 1.1 Events

One JSON object per event. `type` selects the shape. Unknown `type` values and
unknown fields MUST be ignored by readers.

**`text`**: assistant prose.

```json
{"type":"text","id":"t1","delta":"I'll check the checklist first."}
```

`id` names a prose block. Deltas with the same `id` append in order. A writer
starts a new `id` whenever a step has been emitted since the last `text`. Only
top-level prose is emitted; a sub-agent's prose is not.

**`step`**: create or update a step. The first `step` event for an `id` creates
it; later ones merge field by field (a field that is absent is unchanged).

```json
{"type":"step","id":"s1","kind":"command","title":"Bash",
 "summary":"Run the pricing tests","status":"running",
 "startedAt":"2026-10-06T07:00:01.000Z",
 "input":{"command":"npm test -- pricing","description":"Run the pricing tests","cwd":"/work/app"}}
{"type":"step","id":"s1","status":"done","endedAt":"2026-10-06T07:00:09.000Z",
 "exitCode":0,"output":"12 passing\n","outputTruncated":false}
```

| Field | Meaning |
|---|---|
| `id` | Unique within the job. Opaque. |
| `kind` | `command`, `read`, `edit`, `write`, `search`, `fetch`, `tool`, `agent`, `reasoning`, `todo`. Readers render an unknown kind as `tool`. |
| `title` | Short tool label: `Bash`, `Read`, `Edit`, `Grep`, `Agent`, `Thinking`, or a readable MCP tool name such as `Mark Chapter`. |
| `summary` | One human line: the command's description, a file name, a pattern, a URL host, a sub-agent's description. May be absent. |
| `status` | `running`, `done`, `failed`, `cancelled`. |
| `parent` | `id` of the enclosing `agent` step when this step ran inside a sub-agent. Absent at top level. |
| `startedAt`, `endedAt` | ISO 8601 UTC. |
| `input` | Object of strings (and `background` as a boolean). By kind: `command`: `command`, `description`, `cwd`, `background`. `read`: `path`, `range`. `edit`, `write`: `path`, `diff`. `search`: `pattern`, `path`. `fetch`: `url`, `query`. `tool`: `name`, `server`, `json`. `agent`: `description`, `prompt`, `agentType`. `todo`: `items` as an array of `{"text","status"}`. Any field may be absent. |
| `output` | Text result: command output, a sub-agent's final report (markdown), the thought text for `reasoning`. |
| `outputTruncated` | `true` when `output` was cut to fit a cap. |
| `exitCode` | Integer, `command` only, when known. |
| `error` | Short failure text. |

**`step.delta`**: append to a running step's `output` (live command output,
live thinking).

```json
{"type":"step.delta","id":"s1","output":"compiling…\n"}
```

A later `step` event that carries `output` replaces the accumulated text.

**`usage`**: optional, at most a few per job.

```json
{"type":"usage","inputTokens":4210,"outputTokens":612}
```

Rules for writers:

- A step that is still `running` when the job reaches a terminal status is
  treated by readers as `cancelled` (job cancelled or timed out) or `failed`
  (job failed). Writers need not close them.
- Caps: `summary` 200 characters; `input.command`, `input.prompt`, `input.diff`,
  `input.json` 8 KiB each; `output` 32 KiB per step, counting deltas. Past the
  cap a writer stops sending deltas and marks the final `step` with
  `outputTruncated: true`, keeping the head and the tail.
- Secrets never enter the timeline: apply the same redaction relayd applies to
  logs.

### 1.2 Canonical example

Both test suites use this sequence verbatim as a fixture. It covers prose,
reasoning, a command, a read, an edit, a failed command, a sub-agent with nested
steps, and an MCP tool.

```ndjson
{"type":"step","id":"r1","kind":"reasoning","title":"Thinking","status":"running","startedAt":"2026-10-06T07:00:00.000Z"}
{"type":"step.delta","id":"r1","output":"The rounding bug is probably in the tax line."}
{"type":"step","id":"r1","status":"done","endedAt":"2026-10-06T07:00:04.000Z"}
{"type":"text","id":"t1","delta":"I'll look at the pricing module "}
{"type":"text","id":"t1","delta":"and run its tests."}
{"type":"step","id":"s1","kind":"read","title":"Read","summary":"pricing.ts","status":"running","startedAt":"2026-10-06T07:00:05.000Z","input":{"path":"/work/app/src/pricing.ts"}}
{"type":"step","id":"s1","status":"done","endedAt":"2026-10-06T07:00:05.200Z"}
{"type":"step","id":"s2","kind":"command","title":"Bash","summary":"Run the pricing tests","status":"running","startedAt":"2026-10-06T07:00:06.000Z","input":{"command":"npm test -- pricing","description":"Run the pricing tests","cwd":"/work/app"}}
{"type":"step.delta","id":"s2","output":"FAIL rounds half up\n"}
{"type":"step","id":"s2","status":"failed","endedAt":"2026-10-06T07:00:12.000Z","exitCode":1,"output":"FAIL rounds half up\n1 failing\n"}
{"type":"text","id":"t2","delta":"One test fails. Fixing the rounding and asking a sub-agent to audit the other callers."}
{"type":"step","id":"s3","kind":"edit","title":"Edit","summary":"pricing.ts","status":"done","startedAt":"2026-10-06T07:00:14.000Z","endedAt":"2026-10-06T07:00:14.100Z","input":{"path":"/work/app/src/pricing.ts","diff":"-  return Math.floor(total * 100) / 100\n+  return Math.round(total * 100) / 100"}}
{"type":"step","id":"a1","kind":"agent","title":"Agent","summary":"Audit callers of roundPrice","status":"running","startedAt":"2026-10-06T07:00:15.000Z","input":{"description":"Audit callers of roundPrice","prompt":"Find every caller of roundPrice and report any that assume floor.","agentType":"Explore"}}
{"type":"step","id":"s4","parent":"a1","kind":"search","title":"Grep","summary":"roundPrice","status":"done","startedAt":"2026-10-06T07:00:16.000Z","endedAt":"2026-10-06T07:00:16.300Z","input":{"pattern":"roundPrice","path":"/work/app/src"}}
{"type":"step","id":"s5","parent":"a1","kind":"read","title":"Read","summary":"checkout.ts","status":"done","startedAt":"2026-10-06T07:00:17.000Z","endedAt":"2026-10-06T07:00:17.200Z","input":{"path":"/work/app/src/checkout.ts"}}
{"type":"step","id":"a1","status":"done","endedAt":"2026-10-06T07:00:30.000Z","output":"Two callers. Neither assumes floor."}
{"type":"step","id":"s6","kind":"tool","title":"Mark Chapter","status":"done","startedAt":"2026-10-06T07:00:31.000Z","endedAt":"2026-10-06T07:00:31.050Z","input":{"name":"mark_chapter","server":"session","json":"{\"title\":\"Verification\"}"}}
{"type":"step","id":"s7","kind":"command","title":"Bash","summary":"Run the pricing tests","status":"done","startedAt":"2026-10-06T07:00:32.000Z","endedAt":"2026-10-06T07:00:39.000Z","exitCode":0,"input":{"command":"npm test -- pricing"},"output":"12 passing\n"}
{"type":"text","id":"t3","delta":"Fixed. All 12 pricing tests pass and no caller depended on the old behaviour."}
{"type":"usage","inputTokens":4210,"outputTokens":612}
```

Reduced, this is the block sequence: steps [r1], prose t1, steps [s1, s2],
prose t2, steps [s3, a1 (children s4, s5), s6, s7], prose t3. The second group
summarises as "Read a file, ran a command"; the third as "Edited a file, ran an
agent, used a tool, ran a command".

### 1.3 Storage and delivery (relayd)

- Per job, `<dataDir>/logs/<jobId>.timeline.ndjson`: append-only, one event per
  line. The event's **sequence number** is its 1-based line number.
- **Live**: `GET /v1/codex/jobs/:id/stream` accepts a new optional query
  parameter `timeline=<n>`, the count of timeline events the client already
  holds (`0` for all). Only when it is present does the server interleave
  `event: timeline` messages, each `data: {"seq":<n>,"event":{…}}`, for every
  event with `seq > n`, live. These messages carry no `id:` line, so
  `Last-Event-ID` keeps its existing three-part meaning. Without the parameter
  the stream is byte-for-byte what it is today.
- **Fetch**: `GET /v1/codex/jobs/:id/timeline?since=<n>` returns
  `{"jobId","events":[{"seq","event"}…],"next":<n>,"complete":<bool>}`.
  `complete` is true when the job is terminal and nothing follows `next`.
  Responses are capped (2,000 events or 1 MiB); the client pages with `next`.
- **Discovery**: the job object gains optional `timelineEvents` (integer count).
  Absent or zero means the job has no timeline and the phone uses the legacy
  rendering.
- **History**: each message in `GET /v1/codex/threads/:id` gains optional
  `steps`: the complete `step` objects (same shape, no deltas) that happened
  since the previous returned message. The response gains optional
  `trailingSteps` for steps after the last message. In history, `output` is
  capped at 4 KiB per step.
- The legacy channels stay useful for old phones: stdout carries assistant
  prose (and, for Codex, command output as today); stderr carries
  `[relay-step] …` lines.
- API.md Part 1 shapes are frozen. Everything above is a new optional field, a
  new query parameter, a new event name or a new route.

### 1.4 Harness mapping (relayd)

| Harness | Transport | Notes |
|---|---|---|
| Claude Code | `claude --print --output-format stream-json --verbose --include-partial-messages`, wrapped by a runner | `text_delta` to `text`; `thinking` blocks to a `reasoning` step; `tool_use` to a step, closed by its `tool_result`; a `Task`/`Agent` tool is an `agent` step and events carrying its id as `parent_tool_use_id` become its children; `result` supplies the final answer and usage. `RELAYD_CLAUDE_TRANSPORT=print` keeps today's behaviour. |
| Codex | existing app-server runner | `commandExecution`, `fileChange`, `webSearch`, MCP calls and `reasoning` items become steps, including exit codes and output; `agentMessage` deltas become `text`. |
| Cursor, Kimi | unchanged for now | No timeline; legacy rendering. |

`job.result` must stay the final answer only, never the event stream.

## Part 2: the transcript (phone)

A turn renders as its blocks, in order:

- **Prose**: markdown, as today. No bubble; the byline sits on the turn's first
  block.
- **Activity row**: one line for a run of consecutive top-level steps, such as
  "Ran 5 commands, read 2 files", with a chevron. Counts are by kind in order
  of first appearance; the first phrase is capitalised; singular reads "a
  file". Tapping opens the steps sheet.
- **Live row**: while the job is active and a step is running, the row for that
  step is a caps status word in ember (`RUNNING`, `THINKING`, `AGENT`), a
  ticking DM Mono duration, and the step's summary. Status is typographic:
  never a dot or spinner glyph.
- **Steps sheet**: content-sized, same chrome as the composer sheets. One row
  per step: caps kind word, one-line summary, duration. A failed step's word is
  `FAILED` in `statusError`. An `agent` row shows its child count. Tapping a
  row pushes its detail inside the sheet.
- **Step detail**: by kind. Command: description, command (mono), output
  (mono, live while running), exit code when non-zero. Read: path. Edit and
  write: path and diff. Search: pattern and path. Tool: name and JSON. Agent:
  prompt, its child steps (tappable), its report as markdown. Reasoning: the
  thought text.

**Scrolling.** The list follows new content only while the reader is at the
bottom. Scrolling up stops the follow, and a jump-to-latest button appears
centred above the composer. Sending a message returns to the bottom. Opening a
thread lands at the bottom without a visible scroll. Streaming must not
re-layout earlier blocks: prose blocks are stable once the next block starts.
Content must not show through behind the header.

**Fallback.** A job with no timeline renders exactly as today.

## Part 3: the composer (phone)

As drawn on the canvas: one floating card; row two is add, model pill (model and
effort), mic, send. The model sheet is content-sized with agent pills for a new
chat and an Effort page; the Add sheet holds camera, photos, files, permissions
and skills; dictation morphs row two in place with cancel, waveform, duration,
stop and a live send.

## Invariants

- AGENTS.md keyboard rules: no keyboard accessory, no floating dismiss control,
  interactive scroll dismissal, keyboard dismisses on send, taps inside the
  composer do not resign focus.
- A thread stays with its provider.
- Status is typographic: no coloured status dots, no `checkmark.circle.fill`.
  Ember is for the primary action, the user's own content, and live activity.
- Provider auth is untouched: direct subscriptions, no Bedrock, no new
  credentials on the phone.
- relayd stays mTLS/bearer-only on the same routes; the timeline adds no new
  unauthenticated surface. It does carry more than the old logs did (file
  diffs, tool arguments, the output of fast commands), to the same paired
  device that could already read the job's logs and the workspace's files.
  relayd redacts nothing in job logs today, so the timeline is not redacted
  either; if that changes, the redaction belongs in `createTimelineWriter` so
  every harness gets it.
- Old phone with new relayd, and new phone with old relayd, both keep working.
