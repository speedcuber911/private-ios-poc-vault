# Relay review screenshot candidates

Captured from the running native app on the dedicated Relay Review iPhone simulator (iPhone 17 Pro Max, iOS 27). Each PNG is 1320 × 2868, without compositing or generated UI.

The app is a Debug build of the remediation source committed as `85f1eceaf7258280f18847d0c06612e2ecf8602e`. It uses the local simulator server and a fictional Launch checklist project. The displayed output is the actual interactive HTML in `ops/fixtures/launch-checklist.html`; it is representative sample data, not a verified task on Apple's review account.

Proposed order:

1. `iphone/01-workspace-results.png` — first-class Previews tab and workspace-linked outputs.
2. `iphone/02-working-preview.png` — running sample inside Relay; checkbox interaction verified.
3. `iphone/03-source-task.png` — original task, result, and explicit preview action.
4. `iphone/04-workspace-files.png` — native workspace file browser.
5. `iphone/05-data-sharing.png` — existing provider-specific permission disclosure.

The source-job action was re-tested after its automatic-preview suppression fix: declining consent leaves the source conversation visible and does not open the preview automatically.

These are local candidates, not uploaded screenshots. Verify the prepared review account can exercise the same functions before publishing. Relay currently targets iPhone (`UIDeviceFamily = [1]`); iPad testing exercises compatibility mode and does not establish native iPad support. No iPad listing screenshots are proposed.

Existing `artifacts/app-store-1.0/` screenshots were not changed.
