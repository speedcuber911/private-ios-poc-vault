# Run log, approvals, and session-open fixes

Status: approved 2026-09-09 by the owner. Design canvas: "Relay Run Log".

Seven changes reported from real use on the owner's own machine. They are
independent; the order below is the order they were hit.

Apple review is no longer a constraint — the owner has paused App Store
submission to perfect the app for personal use first. Nothing here needs to
preserve a review commitment, but the AI data-sharing disclosure stays
reachable because it is still the honest thing to show before work leaves the
device.

## 1. The run log sheet never updates

`RelayFullLogSheet` is frozen by three independent locks
(`RelayChatView.swift:2677`, `:2736`):

- `let job: CodexJob` — a struct, so the sheet holds a copy taken when the
  user tapped.
- `.task(id: job.id)` — that id never changes, so the task never re-fires.
- `guard text == nil else { return }` — refuses a second load even if it did.

Meanwhile the transcript behind the sheet is driven by the view model, which
keeps polling. That is exactly why one advances and the other does not.

The sheet must read the job from `RelayChatViewModel` rather than a captured
copy, and re-read the log while the job is active. `loadFullLog` already calls
`replaceJob(full)`, so the view model is the natural source: the data was
always arriving, the sheet just held its own dead copy.

While the job is active, poll on the existing job-polling cadence and stop when
it reaches a terminal status. The newest content stays pinned to the bottom
unless the user has scrolled away from it.

## 2. The run log is unreadable

`Text(text).font(AppTheme.monoFont(size: 12))` renders the entire log as one
mono blob, so `## Stdout` shows as literal characters.

Relay already ships `RelayMarkdownProse`, `RelayCodeBlock` and
`RelayMarkdownTable` (`Rendering/RelayMarkdownViews.swift`) and the chat
transcript uses all three. The log sheet must use the same renderer for
assistant prose.

Verbosity is a shape problem, not a length problem — **do not truncate**, the
dropped line is always the one that mattered. Give each kind of content the
density it earns:

| Kind | Rendering |
| --- | --- |
| Assistant prose | markdown prose, full width, provider byline |
| Shell step | one mono line, truncated, with a caps exit status; tap expands its output |
| Warning | one line, `RelayCapsLabel` "Warning" in `AppTheme.statusWarn` |
| Execution receipt | disclosure at the FOOT of the run, closed by default |

The receipt is metadata read once when something is wrong; it currently opens
the sheet. A "Raw" affordance keeps the whole unparsed log one tap away,
copyable, for when the bytes matter more than the story.

Header carries the provider, model and a ticking duration; status stays
typographic and success renders cream (design rules 3 and 5).

## 2b. Where the design lives

Artboards for the running and finished states, and the diagnosis, are in the
"Relay Run Log" canvas. Follow them for layout, density and copy.

## 3. Approvals hang forever

`codex-job-runner.mjs:123` awaits `approvalStore.waitForDecision(record.id)`
with no timeout, so a job that requests approval blocks indefinitely while the
duration keeps climbing. In chat there is no affordance to act on it — the
approval is only reachable from the Sessions tab — so from the owner's seat it
is simply stuck.

**The owner's decision: run with full permissions on their own machine.** That
needs BOTH halves, and half of it does not exist yet:

- `approvalPolicy` is already selectable and can be `never`.
- `sandbox: "workspace-write"` is **hardcoded** at `codex-job-runner.mjs:60`
  and `:70`. Setting approvals to `never` alone makes escaping operations
  *fail* rather than hang — `RelayCodexApprovalPolicy.never` says so itself:
  "Codex cannot ask. Operations outside the workspace sandbox are rejected."

So: make the sandbox configurable, defaulting to today's `workspace-write`, and
accept `danger-full-access`. Thread it as `RELAY_CODEX_SANDBOX` the way
`RELAY_CODEX_APPROVAL_POLICY` already is, validated against the same kind of
allowlist (`read-only`, `workspace-write`, `danger-full-access`) and rejected
with 400 otherwise.

This is a real loosening: `danger-full-access` plus `never` means Codex can
touch anything the daemon user can, with no prompt. It is opt-in, it is the
owner's own box, and the default stays where it is. Do not make it the
built-in default for everyone.

Independently of the policy, `waitForDecision` must not be able to hang a job
forever: give it a bounded wait, and on expiry fail the job with a message that
names approval as the cause rather than leaving a climbing timer.

## 4. GPT-6 efforts are silently dropped

Fixed already on the machine: Codex CLI 0.147.0 → 0.153.4, which is what made
`gpt-6-astra` appear. `model/list` now returns six models.

But `gpt-6-astra` advertises `low, medium, high, xhigh, max, ultra`, and the
allowlist is `["low", "medium", "high", "xhigh"]` in four places —
`catalog.mjs:61,69,77,85`, `catalog.mjs:211`, `catalog.mjs:293`, and
`config.mjs:193`. `max` and `ultra` are filtered out with no error, so the
model arrives without its two strongest settings.

Add both levels to every allowlist, and to `CodexReasoningEffort`
(`CodexModels.swift:1442`) which stops at `.xhigh`. An unknown effort from a
future model must degrade to "not offered", never to a crash.

## 5. Tapping a thread notification opens nothing

`POCVaultApp.swift:266` handles a `job` push by refreshing the feed and
matching **only** `.pendingJob` items:

```swift
guard let item = statusFeedViewModel.feedItems.first(where: { item in
    if case .pendingJob(let job) = item.source { return job.id == jobID }
    return false
}) else { return }
```

`CodexThreadFeedItem.makeFeed` replaces a job with its thread once one exists
(`testCodexThreadFeedUsesThreadsInsteadOfDuplicateJobs`). A notification about
finished work therefore never matches: the user lands on the Sessions tab and
nothing opens, silently, because of the bare `else { return }`.

Match a thread carrying that job as well as a pending job with that id, and
open it with its history. When the feed genuinely has no such item, say so
rather than returning silently.

## 6. Opening a thread shows a blank screen

`RelayChatViewModel.openThread` (`:1003`) does not touch `messages` until
`fetchThreadDetail` returns, so the conversation is blank for the whole round
trip with no title, no spinner and no indication anything is happening.

`b2d34d8` already solved this shape for the source-task path — "Show source
task immediately while refreshing details". Apply the same pattern: set the
thread's identity (title, provider, workspace) and seed the transcript from
what the feed item already carries — `CodexThread` has a title and preview
text — then replace it when the detail lands. Show a loading state for the
body rather than emptiness.

The existing `conversationRevision` guard against out-of-order responses must
be preserved exactly.

## 7. The control rail scrolls vertically and offers refresh

`controlBar` (`RelayChatView.swift:825`) is a horizontal `ScrollView` that
already tries to prevent this with a pinned `.frame(height:)` and
`.scrollBounceBehavior(.basedOnSize, axes: .horizontal)`. That was the wrong
cause. `.refreshable` is applied to the whole chat view at `:122`, and
`refreshable` publishes a `RefreshAction` into the environment that **any**
scroll view in the subtree adopts — including this rail. Pulling down on the
model chips runs the thread refresh and shows its spinner.

Scope refresh to the conversation, and clear it for the rail
(`.environment(\.refresh, nil)`), so a horizontal control strip cannot inherit
a vertical gesture it should never have had.

## 8. The AI data-sharing row leaves the composer

The persistent "Work content to <recipient> · ALLOWED" row
(`RelayChatView.swift:859`) sits above the composer on every send. It states
something that does not change, in the place where the user is trying to type.

Remove the persistent row. Keep `RelayAIDataConsentStore`,
`RelayAIDataConsentSheet` and the first-use consent gate exactly as they are,
and keep the sheet reachable from the chat's overflow menu so the disclosure
can still be read and revisited on demand.

## Invariants

- Keychain and UserDefaults key strings unchanged.
- Derivation label strings (`relay-*-v1`) unchanged.
- `docs/app-store/**` and `artifacts/**` untouched.
- `ClientIdentityStore` untouched.
- Status stays typographic, never a coloured dot; success renders cream.
- Ember stays earned: at most one full-chroma action per screen, plus live
  activity.

## Tests

Keep passing unchanged: `testStatusIndicatorsStayTypographic`,
`testRelayDesignTokensUseEditorialEmberPalette`.

Add coverage for: the log sheet reading the view model rather than a captured
job and stopping its poll at a terminal status; markdown prose in the log;
sandbox validation accepting exactly the three values and rejecting others;
`max`/`ultra` surviving catalog discovery; a thread-backed push route opening
its thread; `openThread` populating identity before the detail arrives; the
control rail not adopting the ancestor's refresh action; and the composer no
longer carrying the persistent data-sharing row while the sheet stays
reachable.
