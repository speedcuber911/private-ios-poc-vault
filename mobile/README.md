# Relay mobile

Relay now uses a Kotlin Multiplatform core with native applications on both
platforms:

- iOS remains SwiftUI and keeps its existing bundle, lifecycle, Keychain,
  networking, WebKit, and Apple-specific integrations.
- Android is a native Jetpack Compose application with Android Keystore,
  OkHttp, and Android WebView integrations.
- `relay-core` is UI-free Kotlin shared by both apps.

This keeps the parts that must behave identically in one place without forcing
either application into a cross-platform UI framework.

## Project layout

```text
mobile/
  androidApp/   Native Android application
  relay-core/   Shared models, wire contract, API repository, and SSE parsing
ios/POCVault/   Existing native Relay iOS application
```

The shared core owns:

- provider and job-status normalization
- tolerant API and signed-manifest data models
- Relay request paths, query parameters, and request payloads
- job/thread/workspace/model/skill/approval decoding
- server-sent event parsing and streamed job-output reduction

Platform code owns:

- SwiftUI or Compose presentation and navigation
- Keychain or Android Keystore credential storage
- URLSession or OkHttp transport and mTLS client identity wiring
- WKWebView or Android WebView certificate handling
- platform permissions, lifecycle, notifications, and other OS features

Keep this boundary: business and wire behavior belongs in `relay-core`; user
interface and operating-system capabilities stay native.

## Build and test

Use JDK 17 and the checked-in Gradle wrapper:

```bash
cd mobile
./gradlew :relay-core:allTests
./gradlew :androidApp:assembleDebug
```

The debug APK is written to:

```text
mobile/androidApp/build/outputs/apk/debug/androidApp-debug.apk
```

Open `mobile/` as the project root in Android Studio to run the app on an
Android 9 (API 28) or newer device.

The existing Xcode target has a build phase that compiles and links
`RelayCore.framework` automatically. A simulator build can be checked with:

```bash
xcodebuild \
  -project ios/POCVault/POCVault.xcodeproj \
  -scheme POCVault \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

## Android first run

1. Open **Settings** in Relay.
2. Set the Relay API base URL for the linked machine or runner.
3. Select the same PKCS#12 client identity used for authorized Relay access and
   enter its passphrase.
4. Save, then open **Workspaces** or **POCs**.

The application does not ship an active machine URL. It fails closed until one
is configured. The imported PKCS#12 bytes and passphrase are encrypted with an
app-only, non-exportable Android Keystore AES-GCM key. They are never written
to this repository or logs. The POC manifest is decoded only after its embedded
Ed25519 public key verifies the exact downloaded bytes.

Relay's current perimeter remains a valid configured client certificate; this
does not claim the credential is hardware-bound to one phone.

## Extending both apps

For a new Relay API capability:

1. Add its serializable models and repository method to `relay-core`.
2. Add common contract tests under `relay-core/src/commonTest`.
3. Expose the behavior through native view models on iOS and Android.
4. Build both targets before handoff.

The enforced workflow and current parity boundary are documented in
[`docs/MOBILE_PARITY.md`](../docs/MOBILE_PARITY.md). Run `ops/verify-mobile` from
the repository root; CI runs the same contract check and both platform builds.

Avoid moving UI state, secure-storage implementations, WebViews, or other
platform APIs into the shared module. That would save little code while making
both applications harder to evolve naturally.
