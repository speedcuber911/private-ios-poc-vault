# Relay on Apple Watch

This is the first companion implementation, based on `main` at `7e54bbf`.
Native builds and physical-device testing are **pending**: the implementation
environment is Linux and has neither Xcode nor a connected Apple Watch.

## What the watch does

Open Relay → New thread → dictate a prompt → review the transcription → choose
a registered folder, model and effort → Send. The Dictate button records on the
watch and forwards audio through the paired iPhone to the same Relay streaming
transcription service used by the phone app. Live text appears while recording;
Stop finishes the transcript and Cancel restores the previous draft. No recording
is automatically sent as a task; the user reviews the text and taps Send.

The watch's native text field remains available for manual editing. Its optional
system input methods are separate from Relay's Dictate button.

The home screen has New thread, a Needs you section, and recent Threads. Opening
a thread shows its status, a short activity summary and the latest agent prose.
Long replies become bounded excerpts retaining the beginning and end. These are
not new AI-generated summaries. A final answer's question can be answered with
Reply, which starts another turn in the same session. An active run can be stopped.

For structured approvals, the watch shows the title, reason, command and working
folder. Approve once and Deny use the server's existing approval API. A request
too long to review fully on the watch must be handled on iPhone. General structured
`request_user_input` questionnaires are not implemented by the current daemon;
this addition does not invent an endpoint for them.

The model list comes from the machine's catalog, limited to direct Codex and
Claude task models. Efforts come from the selected model. Models supporting only
chat mode are not offered in this first version. Folder selection uses registered
workspace IDs; register additional folders through the existing phone flow.
The initial bounded view includes up to 30 models, 40 folders, 12 recent thread
rows, and 4 pending approvals. Older items remain available on iPhone.

## Compatibility and connectivity

- Deployment target: watchOS 9.0. This is intended to cover every SE generation,
  Series 4 and later, and Ultra models **on a compatible watchOS version**. It
  does not cover the original Apple Watch or Series 1–3. Device compatibility
  remains unverified until native builds and hardware tests run.
- The companion iPhone app still requires iOS 17 or later. Xcode must support the
  actual OS versions installed on both devices.
- The watch talks to its paired iPhone through Watch Connectivity. The iPhone
  uses Relay's existing machine connection, pinned TLS/device token or legacy
  mTLS. Provider credentials, node credentials and certificates stay off the watch.
- A reachable iPhone may be woken for a watch request. A disconnected or
  force-quit phone can prevent delivery. Opening Relay on iPhone is the recovery
  step; a GPS-only SE does not need a cellular subscription for this design.
- Standalone watch networking and Family Setup are not supported by this version.
- Automatic refresh runs only while the watch app is active and its composer is
  closed: every 15 seconds for an open running thread, 30 seconds when another
  visible thread is running, and two minutes when idle. Failed refreshes back off
  from 30 seconds to five minutes. Opening the app or a thread refreshes promptly;
  automatic refreshes within five seconds of an existing request are coalesced.
  Manual Refresh and refreshes after explicit actions remain available.
  Structured activity is loaded only for the open thread, when its machine
  exposes a timeline. The watch receives counts and latest prose, never raw tool
  output or reasoning.
- New approvals and completed runs produce haptics when observed by the active
  watch app. This is not an always-running background monitor. Existing iPhone
  notifications may mirror according to the user's Watch notification settings;
  reliable independent watch push delivery is a separate future feature.

## Battery behavior

Agent execution and network calls to the machine stay on the phone/server.
The watch stops its refresh loop when inactive or composing. An already-sent
request may still finish; receiving a background context never starts a new
refresh. The phone avoids resending unchanged background snapshots, and the
watch cancels each request's timeout when its reply arrives. Haptics for newly
observed approvals/completions are limited to the active watch app.

The microphone starts only after an explicit Dictate action and a successful
phone handshake. Capture stops on Stop, Cancel, an interruption, leaving the
screen, inactivity, or the one-minute limit. The watch converts audio to 16 kHz
mono PCM, sends half-second batches with one request in flight, and caps its
waiting audio queue at four seconds. It keeps no recording file. The microphone
level updates from captured audio; no idle waveform timer runs.

The iPhone reuses `RelayStreamingTranscriber` with external audio, so its own
microphone and metering timer stay off. Service authentication stays on iPhone.
Dictation uses finite iOS background time and may end early when iOS suspends the
phone. A lost connection, incomplete transcript, or slow phone produces a warning
and preserves text received so far for review. The phone closes abandoned sessions
after 12 seconds without a batch. Neither device keeps an always-listening session.

These are implementation measures, not a measured battery-life claim. Profile
on the physical SE with Xcode, including an idle screen, a running thread, an
unreachable iPhone, backgrounding, and repeated dictation sessions once Relay
audio forwarding is running on hardware. Confirm polling ends when inactive and compare
energy use under the same device settings before claiming a battery improvement.

## Install and test on your watch

1. On your Mac, pull the updated `main` branch, then open
   `ios/POCVault/POCVault.xcodeproj` in Xcode.
2. Install the iOS and watchOS platform support in Xcode. The iPhone target also
   needs JDK 17 for the existing RelayCore Gradle build; see `mobile/README.md`.
3. Confirm `POCVault` and `RelayWatch` resolve to the same authorized development
   team. Both inherit the existing signing team from the project build settings;
   override `DEVELOPMENT_TEAM` for the whole build when using another authorized
   team. Keep the iPhone ID `com.parikshit.pocvault` and the
   watch ID `com.parikshit.pocvault.watchkitapp`. Automatic signing can register
   the watch ID and device. The watch must have a resolved signing team for
   Xcode Cloud distribution exports as well as local device builds.
4. Pair the watch to your iPhone. Connect/trust the iPhone on the Mac; keep the
   watch unlocked and nearby with Bluetooth/Wi-Fi enabled. Enable Developer Mode
   on iPhone and watch when Xcode requests it. If the switch is initially absent,
   first connect the device through Xcode's device manager, then check again.
5. Select the `POCVault` scheme and your physical iPhone, then Run. This installs
   the updated phone app with the watch bridge and embedded watch app. Complete
   Relay's existing pairing/provider setup on iPhone. For each intended provider,
   complete the phone's existing data-sharing disclosure before first watch use.
   Confirm Relay dictation works on iPhone; the watch uses that build's existing
   transcription configuration. The updated phone app is required for watch audio.
6. Select `RelayWatch` and your paired physical Apple Watch as the run destination,
   then Run. If automatic companion installation is disabled, install Relay in
   the iPhone Watch app under Available Apps. Open Relay on both devices and tap
   Refresh on the watch. Do not provision the iPhone's `.p12` onto the watch.
7. Tap New thread → Dictate and grant microphone access on the watch. Speak a
   short prompt, tap Stop, edit the transcript if needed, choose the run settings,
   then Send. Test cancellation, an interrupted connection, and phone locking
   before relying on it away from the Mac. Repeat without Xcode attached because
   the debugger can change background behavior.

For regular personal use after development testing, archive the **POCVault**
scheme to package the iPhone and watch app together, then distribute through your
existing TestFlight process. A development install depends on the signing
profile's lifetime. Install the iPhone beta in TestFlight; its Information → App
Details section offers installation for an included compatible watch app. App
Store Connect manages the uploaded build; it does not install apps on the watch.
TestFlight/distribution and App Store metadata updates have not been performed by
this change.

## Verification

On a Mac, list iPhone simulator destinations, then pass one to the checker:

```bash
xcodebuild -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -showdestinations
ios/verify-watch.sh 'platform=iOS Simulator,id=<your-simulator-UDID>'
```

This builds the native watch target and runs `RelayWatchTests` in the existing
iPhone test target. The tests cover workspace/model/effort validation, machine
changes, same-session replies, active-run restrictions, approval visibility,
payload size, excerpts, and exclusion of tool logs from progress summaries.
They also cover idle/composer/background refresh policy, failure backoff, and
suppression of unchanged background snapshots. Dictation tests cover bounded PCM
packets, the one-minute audio limit, ordered batches, repeated finalization,
cancellation/expiry, and isolation between machines using an injected transcriber.
These native tests are supplied but were not executed in the Linux environment.

Physical-device acceptance checks:

| Check | Expected result | Status |
| --- | --- | --- |
| 40 mm SE and larger watch layout | Readable at larger text sizes; controls scroll without clipping | Pending |
| Relay dictate, stop, edit | Watch microphone; partial text; final transcript reviewed before Send | Pending |
| Cancel dictation | Recording ends; previous draft restored; no agent run starts | Pending |
| One-minute limit / slow phone / interruption | Capture stops, warning appears where needed, received text survives | Pending |
| Microphone permission denied | Clear recovery message; no microphone or socket left active | Pending |
| Phone dictation regression | Existing phone recording, waveform, Stop and Cancel still work | Pending |
| New thread | Exactly one run with selected registered folder, model and effort | Pending |
| Follow-up reply | Same session and provider; folder cannot silently change | Pending |
| Question/approval | Readable prompt; accept/deny settles the correct pending request | Pending |
| Long approval | No approval action until reviewed on iPhone | Pending |
| Open thread during work | Concise activity and latest agent prose; no terminal dump | Pending |
| Completed/failed/cancelled run | Correct terminal status and one observed transition haptic | Pending |
| iPhone locked, Relay backgrounded | Delivery works when iOS permits background wake | Pending |
| iPhone unreachable or force-quit | No silent queued send; draft and delivery warning remain | Pending |
| Lost reply / app relaunch | Check delivery is read-only and never creates a second run | Pending |
| Machine unpaired or changed | Display context cleared; old commands rejected | Pending |
| Background / composer | No automatic refresh requests; an existing request may finish | Pending |
| Idle / active thread / unreachable phone | Refresh follows the documented cadence and failure backoff | Pending |
| Energy profile on SE | Measure idle, active and dictation energy; no measured claim yet | Pending |

If a send times out, its original request ID and draft remain on the watch. The
phone records a receipt before making a mutation and records success before any
subsequent refresh. Check delivery reads that receipt; it never submits a new job.
An interrupted phone can leave a genuinely ambiguous outcome. Inspect Threads on
iPhone before selecting “I checked on iPhone” and clearing the warning. This is
client-side replay protection, not an end-to-end server idempotency guarantee.

Linux checks cover Swift grammar, Xcode project/reference and plist/scheme
validation, shell syntax, and the repository's Python/manifest checks. These are
not Swift compilation or native test execution. Signing is skipped when the local
manifest signing key is absent. The transcription-service test command could not
run because its `ws` dependency is missing; dependency download was blocked by
network restrictions. No native app has been installed, no service has been
deployed, and live certificate/API checks have not been run.

## Implementation map

- `ios/POCVault/RelayWatch/`: native SwiftUI screens, microphone capture and Watch Connectivity.
- `ios/POCVault/WatchShared/`: bounded, versioned display/command/audio contract.
- `ios/POCVault/POCVault/Watch/`: phone bridge and transcript projection.
- `ios/POCVault/POCVault/Audio/RelayStreamingTranscriber.swift`: shared phone/watch transcription path.
- `ios/POCVault/POCVaultTests/RelayWatchTests.swift`: native contract/projection tests.
- `ios/verify-watch.sh`: Mac build and test entry point.
- `relay-watch-preview.html`: illustrative interactive flow with sample data.

## Apple references

- [Watch/iPhone compatibility](https://support.apple.com/en-us/118490)
- [Watch Connectivity and delivery behavior](https://developer.apple.com/documentation/watchconnectivity/transferring-data-with-watch-connectivity)
- [Watch Connectivity power guidance](https://developer.apple.com/documentation/watchconnectivity/wcsession)
- [watchOS networking limits](https://developer.apple.com/documentation/technotes/tn3135-low-level-networking-on-watchos)
- [Installing betas with TestFlight](https://testflight.apple.com/)
- [Single-target watch apps](https://developer.apple.com/documentation/watchos-apps/migrating-to-a-single-target-watchos-app)
- [Running on a physical device](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices)
