# Removing dead surface from the iOS app

Status: approved 2026-09-09. Follows `2026-09-08-byo-vm-simplification.md`.

The BYO change removed machine allocation from the product but left the
screens that described the old one. This spec removes that surface. It is
subtraction plus two small repairs; it adds no feature.

Owner's decisions (2026-09-09): remove the dead surface; cut the published
catalog outright. The four-tab information architecture stays as it is.

## 1. Cut the published catalog

The catalog is a signed manifest fetched from `vault.pocs.conformal.live`,
verified with Ed25519 and gated on a publisher-supplied client certificate.
It predates BYO, shares no data with the machine, and its failure copy sends
people to a Diagnostics panel this spec also deletes.

Delete outright:

- `Networking/ManifestClient.swift`
- `Views/LibraryViewModel.swift` (`LibraryViewModel`, `PreviewFilter`,
  `PreviewTrustCopy`)
- `Models/POCManifest.swift`, `Models/POCEntry.swift`
- From `Views/LibraryView.swift`: `LibraryView`, `PreviewDetailsView`,
  `SearchBox`, `POCSectionHeader`, `POCEntryCard`, `RelayLogoMark`
- `AppConfiguration.manifestURL`, `.signatureURL`,
  `.trustedManifestPublicKey`, `configuredPublicKey`, `rawPublicKeyData`,
  and `SupportConfig.manifestURL` / `.signatureURL` / `.manifestPublicKey`
- `Info.plist`: `POCVaultManifestURL`, `POCVaultSignatureURL`,
  `POCVaultManifestPublicKey`, and the build settings that inject them

`Views/LibraryView.swift` keeps `RelayPreviewsView` and `StatusCard`. The
segmented `Picker("Preview source")` goes with the catalog: the tab shows
workspace results only, so the control has one option and is deleted rather
than left showing a single segment.

`manifestClient` stops being threaded through `POCVaultApp`,
`POCVaultRootView`, `RelayPreviewsView`, `CodexStatusView` and
`DiagnosticsView`. `previewIdentityRevision` and the
`identityStore.$lastImportedCertificateName` subscription that drove it go
too — they existed to reload the catalog after a certificate import.

## 2. Cut the p12 / mTLS Diagnostics surface

A QR-paired phone authenticates with a derived bearer token, not a client
certificate. `DiagnosticsView` still reports on the certificate path, so two
of its seven checks fail permanently and correctly on every paired phone.

Delete from `Views/DiagnosticsView.swift`: `certificatePanel`,
`certificateHeader`, `importCertificateForm`, `importDefaultCertificate`,
`refreshAndImportFromSetupEnvironmentIfNeeded`, the `passphrase`,
`importError` and `isImportExpanded` state, and these checks — "Support
directory", "Support config", "P12 file available", "Keychain identity",
"Manifest URL", "Signature public key".

Replace them with checks that are true of a paired phone. `DiagnosticsView`
takes `nodeStore: RelayNodeStore` and reports, all locally knowable:

| Check | Detail | Passing when |
| --- | --- | --- |
| Runtime | `AppConfiguration.runtimeMode` | always |
| Machine | node name, else "No machine paired" | `nodeStore.hasMachine` |
| Address | `node.apiBaseURL.absoluteString` | a node is paired |
| Link | "Pinned CA, device token" / "Pairing material missing" | the pinned CA and device token are both present |
| Relay cloud | "Connected" / "Not connected — optional" | always; not connected is a normal state |

Status stays typographic (design rule 5). "Not connected" renders cream, not
red, because it is not a fault.

**`ClientIdentityStore` itself is not touched.** It holds the pinned CA and
the device bearer token for the paired node — `deviceToken(for:)` at
`CodexClient.swift:1313` and `credential()` at `:292` and `:1337` are on the
live path — and `importIdentityFromSetupEnvironmentIfNeeded()` at app init
stays, so a legacy personal install still imports automatically. Only the
manual import UI goes. Keychain and UserDefaults key strings are unchanged;
renaming one orphans credentials on an installed build.

## 3. Repair: the browser header claims an auth model that is gone

`Browser/FileBrowserView.swift:88` renders `"Connected · mTLS"` above every
root listing, permanently, and it has been false since QR pairing landed.

Status that never changes carries no information, so the healthy state says
nothing about the connection and names the machine instead — which is also
the question people actually have when browsing a whole filesystem. Add a
`machineLabel: String?` parameter, passed from `POCVaultRootView` out of
`nodeStore.pairedNode?.nodeName`, and render it as the root header's
subtitle in `AppTheme.monoFont`. On error the existing `RelayCapsLabel`
returns reading "Offline" in `AppTheme.statusError`.

## 4. Repair: a "+" that only changes tabs

`POCVaultApp.swift:371` wires the Sessions tab's new-session button to
`selectedRootTab = .workspaces`. It navigates instead of acting, which reads
as a broken button. (`:460` does the same for the browser menu's Previews
item; that one disappears with §1 only if the menu item is removed — remove
it, since the Previews tab is one tap away in the tab bar.)

Sessions' `+` presents a workspace picker sheet: `fetchCodexWorkspaces()`,
rows of `CodexWorkspace` name over `path`, and picking one calls
`openNewSession(folderPath: nil, workspaceID:)`. On fetch failure the sheet
shows the error and a "Browse files instead" button that does the old tab
switch — the fallback stays reachable, it just stops being the whole
behaviour.

## Invariants

- Pairing derivation label strings are frozen cross-language wire values.
- Keychain / UserDefaults key strings are unchanged.
- `docs/app-store/**` and `artifacts/**` are not touched.
- No provider-auth environment variables are set or read.

## Tests

`testStatusIndicatorsStayTypographic` and
`testRelayDesignTokensUseEditorialEmberPalette` must keep passing unchanged
— they are the design-language guards.

Delete, as they test deleted code: `testDecodesManifestEntriesWithISO8601Dates`,
`testSearchMatchesTitleSummaryAndTags`,
`testEd25519SignatureVerificationUsesRawPublicKeyBytes`,
`testPreviewCertificateRequirementIsSeparateFromCatalogIntegrity`,
`testPreviewCatalogResetClearsVerifiedStateAndSearch`,
`testLibraryRecentFilterShowsEmptyStateInsteadOfAllEntries`.

Update: `testPreviewsAreFirstClassAndReuseAuthenticatedOutputViewers` (drop
the catalog assertions, keep the workspace-results ones) and
`testRootUsesNativeTabsIncludingPreviewsWhileKeepingFileBrowserNavigation`
(the four tabs stay; `manifestClient` no longer threads through).

Add:

- the browser root header carries no "mTLS" string and no permanent
  connection status
- `DiagnosticsView` mentions neither `.p12` nor `mTLS`, and its checks name
  the paired machine
- the Sessions `+` opens a workspace picker rather than assigning
  `selectedRootTab`
