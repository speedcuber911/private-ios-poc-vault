# Merge assessment — `origin/codex/carplay-relay`

> Written 2026-08-09 during the revamp closure pass. Status: **parked, do not
> textual-merge.** See "Recommended path" below.

## What the branch is

One commit (`d86b20b`, 2026-05-23): "feat: add relay carplay dashboard". Adds a
read-only CarPlay dashboard — `CarPlay/RelayCarPlayDashboard.swift` (templates +
snapshot model) and `CarPlay/RelayCarPlaySceneDelegate.swift` (CPTemplateApplication
scene that builds its own `ManifestClient`/`CodexClient`, fetches manifest, health,
and per-provider threads/jobs, renders a dashboard template), plus CarPlay
entitlements, Info.plist scene manifest, pbxproj registrations, model/test additions.

## Why it cannot merge onto current main

The branch forked from `4f79767` (2026-05-23) — **23 commits behind** current main,
which now contains the files-first revamp (I0–I6). Conflicts are structural, not
textual:

| Branch touches | Current main reality |
|---|---|
| `Views/CodexConsoleView.swift` (+183) | **File deleted** in I5 |
| `Views/CodexConsoleViewModel.swift` (+227) | **File deleted** in I5 |
| `POCVaultApp.swift` (+99, TabView era) | Rewritten: NavigationStack file-browser root, console VMs replaced by `RelayChatSessionStore` + `StatusFeedViewModel` |
| `ManifestTests.swift` (+173, console tests) | Console tests deleted/rewritten (suite now 79 green) |
| `CodexClient.fetchHealth()` / `CodexHealth` | **Deleted** in I5 (console-only) |
| `CodexModels.swift` (+118) | Heavily reshaped (fs entries, RelayModelChoice era) |
| `project.pbxproj` (+20) | ID ranges advanced by I0–I3 registrations |

A `git merge` would produce modify/delete conflicts on two deleted multi-thousand-line
files and would compile against removed symbols even if textually resolved.

## What is still salvageable

The CarPlay feature itself is largely self-contained and portable:

- The two `CarPlay/*.swift` files build their own clients and don't depend on the
  app's view hierarchy — only their **data hooks** are stale:
  - `fetchHealth()`/`CodexHealth` → deleted; either re-add a minimal health fetch
    (the server still serves the route) or drop the health tile.
  - `fetchThreads`/`fetchJobs` per provider → still live; signatures unchanged.
- Entitlements + Info.plist scene manifest + pbxproj registration are mechanical
  re-adds (pbxproj IDs must be re-issued under the current `1000…/2000…` sequence).
- The branch's `ManifestTests` additions targeting console structure are obsolete;
  its CarPlay-specific model tests can be ported.

Estimated port effort: small (hours, not days) — but it is **new feature work**, not
a merge.

## Recommended path

1. **Do not merge the branch as-is.** Close/retire `codex/carplay-relay` once its
   content is ported.
2. Coordinate with the Codex CLI worktree first — it is actively working; if it
   rebases or supersedes this branch, port from the newer tip instead.
3. Port = cherry-pick the two `CarPlay/` files + entitlements/Info.plist scene
   entries onto current main, re-register in pbxproj, retarget the health tile
   (re-add a minimal `fetchHealth` or drop it), add CarPlay tests to the current
   suite shape.
