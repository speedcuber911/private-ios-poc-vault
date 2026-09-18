# Relay mobile

Relay ships one mobile application — native SwiftUI on iOS — over a UI-free
Kotlin Multiplatform core.

- iOS is SwiftUI and owns its bundle, lifecycle, Keychain, networking, WebKit,
  and Apple-specific integrations.
- `relay-core` is UI-free Kotlin compiled into `RelayCore.framework` and linked
  into the iOS target.

The Android application was removed; `relay-core` stays because it holds the
wire contract and normalization rules, and it carries its own tests that run
without a simulator or a UI.

## Project layout

```text
mobile/
  relay-core/   Shared models, wire contract, API repository, and SSE parsing
ios/POCVault/   Native Relay iOS application
```

The core owns:

- provider and job-status normalization
- tolerant API and signed-manifest data models
- Relay request paths, query parameters, and request payloads
- job/thread/workspace/model/skill/approval decoding
- server-sent event parsing and streamed job-output reduction

Platform code owns:

- SwiftUI presentation and navigation
- Keychain credential storage
- URLSession transport and mTLS client identity wiring
- WKWebView certificate handling
- permissions, lifecycle, notifications, and other OS features

Keep this boundary: business and wire behavior belongs in `relay-core`; user
interface and operating-system capabilities stay native.

## Build and test

Use JDK 17 and the checked-in Gradle wrapper:

```bash
cd mobile
./gradlew :relay-core:allTests
```

The Xcode target has a build phase that compiles and links
`RelayCore.framework` automatically, so building the app builds the core. A
simulator build can be checked with:

```bash
xcodebuild \
  -project ios/POCVault/POCVault.xcodeproj \
  -scheme POCVault \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Xcode Cloud installs the required JDK 17 from
`ios/POCVault/ci_scripts/ci_post_clone.sh`. The Xcode build helper resolves the
Homebrew JDK explicitly because versioned Homebrew JDKs are keg-only and may
not appear on the build phase's default `PATH`.

## Adding a Relay API capability

1. Add its serializable models and repository method to `relay-core`.
2. Add common contract tests under `relay-core/src/commonTest`.
3. Expose the behavior through the iOS view models.

Avoid moving UI state, secure-storage implementations, WebViews, or other
platform APIs into the shared module. That would save little code while making
the application harder to evolve naturally.
