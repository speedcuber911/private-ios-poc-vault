# Apple Sign-In Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show spinner + “Signing in…” on the Apple button slot while Relay finishes Apple auth; keep the primary credential button labeled and disabled only.

**Architecture:** Local `@State appleSignInPending` in `AuthenticationView`, set around `signInWithApple`. When true (and `isWorking`), swap Apple button for a matching capsule status control. Primary button shows spinner only when `isWorking && !appleSignInPending`.

**Tech Stack:** SwiftUI, existing `AuthenticationView` / `AppTheme`

---

### Task 1: Apple pending loading UI

**Files:**
- Modify: `ios/POCVault/POCVault/Views/AuthenticationView.swift`

- [x] Add `@State private var appleSignInPending = false`
- [x] In `handleAppleCompletion` success path, set `appleSignInPending = true` before the Task; clear it in `defer` when the Task finishes
- [x] In `actions`, when `appleSignInPending`, show capsule with ProgressView + “Signing in…” instead of `SignInWithAppleButton`
- [x] Primary button: spinner only when `accountStore.isWorking && !appleSignInPending`
- [x] Build/install on device and verify the post-Apple wait shows the status
