# Relay mobile parity

Relay has two native apps and one shared behavioral contract. “Parity” means the
same user workflow produces the same Relay API request, accepts the same tolerant
response shapes, enforces the same provider/session rules, and exposes the same
security boundary. It does not mean SwiftUI and Compose must have identical code
or pixel-for-pixel UI.

## Source of truth

Put provider/status normalization, wire models, request construction, SSE
reduction, compatibility fallbacks, and other UI-free behavior in
`mobile/relay-core`. iOS may expose Swift-friendly adapters, but must not invent a
second rule. Keep Keychain/Keystore, URLSession/OkHttp, WebKit/WebView, permissions,
and native presentation in their platform targets.

`mobile/parity-contract.json` is the machine-checked ledger of workflows that are
guaranteed on both apps. It also records known differences so they cannot be
quietly described as full parity.

## Required change flow

For every mobile behavior change:

1. Change `relay-core` first when the behavior is UI-free.
2. Add or update a common contract test.
3. Wire the native iOS and Android surfaces in the same pull request.
4. Update `mobile/parity-contract.json` when a capability is added, removed, or
   intentionally platform-specific.
5. Run `ops/verify-mobile` before handoff.

The `Mobile parity` GitHub Actions workflow repeats the evidence check, shared
tests, Android APK build, and iOS Simulator build. Configure that workflow as a
required branch-protection check on `main`; otherwise CI can report a failure but
cannot stop a direct merge.

For a local comparison against a branch or commit:

```bash
MOBILE_PARITY_BASE=origin/main ops/verify-mobile
```

The change guard rejects edits to shared iOS behavior without Android/shared-core
work or an explicit parity-ledger review, and vice versa. This is a forcing
function for human review; no static tool can infer that two independently
designed screens are semantically identical.

## Current boundary

The checked parity surface covers provider/status normalization, workspace and
thread control, task start/resume, provider locking, live job output, approval
fallbacks for older runners, trusted artifacts, localhost previews, and signed
private POCs.

Android 0.1 is not yet the entire public iOS product. Account/trial/CLI handoff,
file viewing, terminal, voice capture, and completion notifications remain
explicit Android gaps in the parity ledger. Apple identity and APNs also require
Android-native equivalents rather than copied Apple implementations. Do not call
the products fully feature-identical until those gap entries are removed.
