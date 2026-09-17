---
name: relay-handoff
description: Publish the current repository work and preserve its native Codex conversations on a directly paired Relay machine. Use when the user asks to hand off, continue, or sync repo work to Relay or EC2. This commits and pushes only the active task, then syncs native sessions without the legacy cloud handoff flow.
---

# Relay Repository Continuity

Execute the workflow when the user explicitly asks to move, continue, hand off, or sync the current repository to Relay. That request authorizes the scoped commit and normal push described here.

1. Stay in the current Git repository. Inspect its instructions, branch, remotes, status, and upstream divergence.
2. Identify the files that belong to the active user-requested task from the conversation and diff. Preserve all unrelated tracked and untracked work.
3. Run focused validation for the active change. Stage only its explicit paths or hunks, run `git diff --cached --check`, inspect the staged diff, and scan it for repository-appropriate secret patterns.
4. If the active task has uncommitted changes, create one normal task commit with an accurate message. Do not create an empty or throwaway handoff commit.
5. Fetch the upstream branch immediately before publishing. Integrate upstream safely while preserving unrelated work, push normally without force, fetch again, and require `git rev-list --left-right --count HEAD...<upstream>` to be `0 0`.
6. When an existing authenticated shell route to the paired Relay machine is already configured, fast-forward the mapped remote repository to the pushed branch and verify its `HEAD` equals the local pushed commit. Read only the workspace mapping fields from Relay config; never print its token or CA. Refuse to overwrite, reset, clean, or stash a dirty remote checkout.
7. Run `relay sync-sessions` from the local repository. If it reports `workspace_required`, list workspaces and select the unambiguous repository match with `--workspace <id>`. If it reports `direct_not_connected`, explain the one-time pairing prerequisite and use the single-use link from `relayd pair --no-qr` with `relay connect '<Link>'` before retrying.
8. Report the pushed commit and parity, remote repository revision when updated, and imported/current/conflicting/skipped session counts. Preserve session conflicts instead of overwriting either side.

Never run `relay handoff`. Never stage unrelated files, force-push, or expose Relay pairing credentials. If Git publication fails, do not describe code as available remotely; session sync may still run, but report the repository mismatch clearly.
