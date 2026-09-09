# Approvals you can answer, and a sandbox you can choose

Status: approved 2026-09-09 by the owner. Follows
`2026-09-09-run-log-and-session-fixes.md` (§3) and supersedes its premise: the
owner does not want a machine-wide "full permissions" switch buried in an env
file. They want to set the level themselves from the app, and — at minimum — a
button on screen when an approval arrives.

That is the better shape. An answerable approval fixes the hang without
loosening anything, and it makes the loosening optional rather than necessary.

## 1. The approval channel already exists

Nothing needs inventing. All of this is built and working today:

- `product/relayd/src/approval-store.mjs` creates the record and
  `waitForDecision` parks the job on it.
- `GET /v1/codex/approvals` and the decide route are served;
  `CodexClient.fetchPendingApprovalsIfSupported()` (`:599`),
  `decideApproval(id:decision:message:)` (`:607`) and
  `decideFirstPendingApproval(jobID:decision:)` (`:618`) all exist.
- `StatusFeedViewModel` fetches them and `RelayApprovalCard` renders
  Approve / Deny in the Sessions tab.
- The push notification's **RELAY_APPROVE / RELAY_DENY** action buttons already
  call `decideFirstPendingApproval` (`RelayPushService.swift:187`).

So an approval can be answered from a notification and from the Sessions tab —
everywhere except the screen the user is actually looking at while it happens.
`RelayChatViewModel` has no approval state at all.

The comment at `RelayChatViewModel.swift:235` — "Codex keeps its runner-enforced
sandbox policy until the backend has a true interactive approval channel; we do
not present a phone toggle that the current executor would ignore" — describes a
world that no longer exists. Update it rather than leaving it to mislead the
next reader.

## 2. Answer the approval where it happens

`RelayChatViewModel` gains pending-approval state for the conversation's own
jobs, refreshed on the cadence the view model already polls active jobs on, and
cleared when a job reaches a terminal status.

An approval for an active job in this conversation renders **in the transcript,
in position**, not as a banner and not as a sheet — it is part of what the run
is doing, and it is the reason the duration has stopped meaning anything.

The card carries: the provider badge, the caps status `Needs approval`, the
title, the command in `AppTheme.monoFont`, the reason when the runner gave one,
and two actions — **Approve** and **Deny**. Approve is this card's one earned
ember; Deny is `RelayOutlineButtonStyle`. Follow the existing `RelayApprovalCard`
in `POCVaultApp.swift:950`, which already solves this layout — extract it to a
shared file rather than writing a second one that will drift.

Deciding calls `decideApproval` and optimistically clears the card, then lets
the next refresh confirm. A decision that fails restores the card and surfaces
the error; the job must never be left looking answered when it is not.

While an approval is outstanding the run's status reads `Needs approval`, not a
climbing timer pretending to be progress.

## 3. Let the user choose the sandbox

The permission picker already exists — `permissionChip` in the control rail
opens it, and it already sets the Codex approval policy. Add the Codex sandbox
to the same sheet, so one control answers one question: how much is this agent
allowed to do.

Three levels, named for what they mean rather than what the runner calls them:

| Level | Wire value | Meaning |
| --- | --- | --- |
| Read only | `read-only` | Can read the workspace. Cannot write or run. |
| Workspace | `workspace-write` | Can change this workspace. Anything outside it asks. |
| Whole machine | `danger-full-access` | No sandbox. Anything the daemon user can do. |

`workspace-write` stays the default. "Whole machine" must state its
consequence in the picker in one line — it is not a preference, it is a grant.

The choice persists per provider in `UserDefaults` beside
`relay.codex.approvalPolicy`, travels on the job create request as `sandbox`,
and relayd validates it against exactly those three values with a 400 otherwise
(the plumbing from the previous spec's §3 provides the runner side).

Sandbox and approval policy are independent and both are sent. "Whole machine"
with "Never ask" is the combination the owner asked for; it is reachable in two
taps and is nobody's default.

## 4. Do not remove the escape hatch

`waitForDecision` still gets the bounded wait from the previous spec's §3. An
approval that no one answers — the phone is off, the notification was swiped —
must end the job with a message naming approval as the cause, rather than
leaving a job parked forever holding a runner process.

## Invariants

Unchanged from `2026-09-09-run-log-and-session-fixes.md`: keychain and
UserDefaults key strings, `relay-*-v1` labels, `ClientIdentityStore`,
`docs/app-store/**`, `artifacts/**`. Status stays typographic; success renders
cream; ember stays earned.

## Tests

- an approval for a job in this conversation appears in the transcript, and
  approving it calls `decideApproval` with that approval's id
- a failed decision restores the card rather than swallowing it
- approvals for other conversations' jobs do not appear here
- the sandbox picker offers exactly the three levels, defaults to
  `workspace-write`, and sends the selected value on job create
- relayd rejects an unknown sandbox value with 400
- `RelayApprovalCard` has one definition, used by both surfaces
