---
name: relay-handoff
description: Hand the active Claude Code, Codex, Cursor, or Kimi coding session and repository work off to Relay using the local Relay CLI. Use when the user says "handoff to Relay", "send this to Relay", "continue this on Relay", "move this session to my phone", "I am leaving my desk", or otherwise asks to transfer the current agent work to Relay.
---

# Relay Handoff

Execute the handoff; do not only explain the commands.

## Workflow

1. Confirm the current working directory is the repository whose active work the user means to transfer. Do not search other repositories or switch projects unless the user identifies another one.
2. Check that `relay` is on `PATH`. If it is absent, stop and give the reviewed install command from the Relay project. Do not silently run a remote `curl | sh` installer.
3. Run `relay handoff` from the active repository without `--no-push`.
4. Recover only from the explicit Relay error that occurred:
   - `not_logged_in` or `no_machine_pinned`: run `relay login`, keep the terminal visible, and tell the user to approve its QR/device code in Relay. After approval, run `relay init`, explain that the next step transfers available GitHub and provider login credentials sealed to their Relay machine, run `relay sync-auth`, then retry `relay handoff`.
   - `repo_not_registered`: run `relay init`, then retry `relay handoff`.
   - `handoff_failed` with a Git/provider authentication reason: run `relay sync-auth`, then retry once. Cursor has no portable login; if Cursor is the missing provider, tell the user to sign in on the Relay machine.
   - `no_git_identity`: inspect `git config --show-origin --get user.name` and `user.email`. Ask the user for the intended identity if either is missing; never invent or globally set one.
   - Any other failure: report the exact failed stage and stop. Do not delete the handoff branch unless the user asks.
5. Report the real terminal outcome:
   - `Ready on your machine` means the handoff is complete.
   - `Still pending` means recorded but not collected; tell the user to check `relay status`.
   - `failed` is failure even if a branch was pushed.

## Boundaries

- `relay login` links and pins a Relay machine.
- `relay sync-auth` transfers available GitHub, Claude Code, Codex, and Kimi credentials. It does not transfer settings, plugins, skills, or slash commands. Cursor login is not portable.
- `relay handoff` transfers the active session and repository work. It does not transfer provider credentials.
- Preserve the user's working tree and index. Relay uses Git plumbing for its handoff branch; do not stage, stash, commit, reset, or clean on its behalf.
- Surface any secret-shaped paths Relay withheld. Never bypass that protection.
- Do not claim success from a pushed branch, a cloud record, or a delivered state; wait for Relay's terminal ready/failed/pending result.
