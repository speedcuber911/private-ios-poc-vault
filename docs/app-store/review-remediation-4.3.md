# Relay App Review 4.3 remediation

Prepared 2026-08-30 for App Store Connect app `6800257362`, bundle `com.parikshit.pocvault`, version `1.0`. This is a preparation/evidence document, not a record of a successful submission. The release owner subsequently found processed build 46 from `58bdb03`; the rejected App Store attachment was build 38. Resolve the replacement build number from its processed App Store Connect record rather than assuming a number.

The rejected build 38 and generic 4.3(a) feedback were supplied by the release owner. This document's implementation findings were checked against the local source tree. It does not claim live review-account, deployed-service, screenshot, or replacement-binary verification.

## Positioning

Lead with the linked sequence: **workspace → run → Previews → inspect output or working app → follow up**. Handoff is a supporting workflow. The implementation combines these actions in one native client; the claim is a specific workflow, not that no other app has any individual feature.

The agreed entry point is a first-class **Previews** tab with **Workspace results** selected by default and **Published catalog** as a separate source. Workspace results reads actual artifacts and detected loopback web addresses from the latest 100 jobs on the currently linked machine. It requires that machine's existing authorization, not access to the legacy published catalog. Published catalog remains separately configured, verifies its manifest metadata before listing entries, and explains each entry's access requirement.

`metadata.en-US.json` contains draft English (US) copy. Its public listing fields are complete. Review notes and reply are deliberately marked as drafts: replace the review fixture references with live-verified names and remove operator instructions before posting. The reply's claim about the attached build and screenshots must be true before it is sent. Preserve existing App Review Sign-in Information, contact details, purchase instructions and access arrangements; never copy credentials into this folder.

Do not lead with provider names, “AI agents, within reach,” a subscription paywall, or a generic response screen. Do not use competitor names in keywords or assert that a private hash comparison proves originality. Do not call the privacy issue “approved”: it was not repeated in the supplied later feedback, which is narrower evidence.

## Implementation evidence and review route

Line numbers can move during parallel implementation; named declarations are the stable lookup points.

| Capability | Source evidence | Observable verification | Claim boundary |
| --- | --- | --- | --- |
| Workspace-scoped work | `ios/POCVault/POCVault/Browser/FileBrowserView.swift`: `contextMenuItems`, `onOpenChat`; `POCVaultApp.swift`: `browserScreen`, `openNewSession`; `product/relayd/src/workspaces.mjs`: `resolveWorkspaceById`, `browseWorkspaceForPath` | Workspaces → prepared project folder → browse files → open chat here; verify conversation uses the selected folder. | The server controls the browse root and resolves registered/dynamic workspace IDs. Do not advertise arbitrary phone-supplied filesystem execution. |
| Mac-to-machine handoff | `product/cli/src/commands/handoff.mjs`: `buildManifest`, sealed manifest/transcript flow; `product/relayd/src/handoff.mjs`: import/resume path; `Models/RelayHandoff.swift`; `Views/RelayHandoffCardView.swift` | In a prepared workspace, open Threads and inspect a real handoff card: repository/base branch, source computer, excerpt, change summary and Continue. | Requires compatible CLI, configured machine and GitHub repository. A Mac session listing by itself is metadata-only and cannot promise exact continuation. Handoff file filtering is name-based, not a guarantee that all secrets/personal data are removed. |
| Workspace results | `Views/LibraryView.swift`: `RelayPreviewsView`; `Views/LibraryViewModel.swift`: `WorkspacePreviewResult`; Android `RelayApp.kt`: `WorkspacePreviewsScreen`; `RelayViewModel.kt`: `loadPreviewResults` | Previews → Workspace results → real artifact or live-app output, labeled with its workspace/task context. iOS calls the live action Open live app; Android calls it Open running app. Both provide View source job. | Latest 100 jobs, not a complete historical index. Uses artifacts and URLs the jobs actually report, not file-type inference over the entire machine. A detected URL is not a health check or promise the service is still running. |
| Task-linked local preview | `Views/RelayChatView.swift`: `RelayRemotePreviewViewer`, `RelayAppPreviewNotice`; `Networking/CodexClient.swift`: `createPreview`; `product/relayd/src/previews.mjs`: `routeAuthenticated`, `validatedLoopbackTarget`, `jobReferencesURL` | In Workspace results, open the prepared live app; in its original conversation the existing action is Show app. Interact with the actual result and return to Relay. | A preview must be referenced by its source job. Default lease is 30 minutes; the local service must still be running. Preview proxy uses a capability URL, so do not claim every subrequest is certificate authenticated or impossible to share. |
| Native file and result inspection | `Browser/FileViewerView.swift`; `Views/RelayChatView.swift`: artifact/result renderers; `Networking/CodexClient.swift` | Open a source file in Workspaces, then a completed task's output/artifact in its conversation. | Do not advertise full desktop IDE editing or every file type unless demonstrated. |
| Approval inbox | `POCVaultApp.swift`: `CodexStatusFeedViewModel`, `RelayApprovalCard`; `Networking/CodexClient.swift`: `fetchPendingApprovalsIfSupported`, `decideApproval`; `product/relayd/src/approval-store.mjs` | Sessions shows a real pending supported request with action/reason and Approve, Deny, Open. | Requires a supported provider/service and pending request. Older servers may return an empty inbox. Do not manufacture an approval screenshot or trigger a dangerous command to obtain one. |
| Hosted or user-managed machine | `Views/RelayOnboardingView.swift`: `forkActions`; `Views/AccountSettingsView.swift`: linked-computer and Relay Hosted sections; `Services/RelaySubscriptionStore.swift` | View onboarding's own-machine option or Settings' linked machine. Hosted account shows subscription controls and Restore Purchases. | Hosted processing is on Relay infrastructure. Provider access is separate. Do not claim end-to-end encryption of all product data, zero data collection, or that account services disappear with own hardware. |
| Provider-specific consent | `Views/RelayChatView.swift`: `RelayAIDataConsentSheet`, persistent `AI data sharing` row; `Models/CodexModels.swift`: `RelayAIDataConsentStore` | Open chat even when disconnected. Inspect provider recipient and content categories. Not Now sends nothing; review-only Allow stores consent without submitting a prompt. | Work content may itself contain personal information. Distinguish no automatic transmission of Relay identity/billing fields to the provider from “no user information is shared.” |
| Signed prototype catalog | `Networking/ManifestClient.swift`: `fetchManifest`, `verifySignature`; `Views/LibraryView.swift`: `PreviewDetailsView`; `Web/AuthenticatedWebView.swift`; `ops/render-manifest.py`; `ops/sign-manifest.py` | Previews → Published catalog → Preview details → Open preview, only after verifying catalog and entry authorization. Details show host/update/tags, Catalog integrity and Access. | Catalog uses global manifest configuration while agent requests may use a per-account machine. A hosted-account bearer token does not automatically grant global catalog mTLS access. Catalog signature validation does not verify downloaded page contents. Never expose private catalog entries to make review easier. |

### Hosted review access: source-only conclusion

Hosted pairing imports its identity with `trialHost: readyTrial.sni` and stores a bearer token for that exact node host in `RelayTrialFlowModel`. `ClientIdentityStore.deviceToken(for:)` returns a token only for the stored matching host. The manifest client fetches the separate configured global catalog and responds to a client-certificate challenge; it does not attach the hosted node bearer. A certificate issued by a node-specific CA is not evidence that the legacy catalog trusts it.

Therefore, standard hosted-account sign-in must **not** be presented as enabling the published catalog. Workspace results is the reviewable primary flow. The release owner observed public catalog health returning 200 and unauthenticated manifest returning 403, but no authorized manifest fetch has been demonstrated. Health 200 is availability evidence, not authorization evidence. Do not export an operator certificate, change catalog permissions or reuse a personal private catalog to fill this gap.

### Source-history evidence

The following commits are concrete provenance points in this repository. They show the features evolving; they are not a global similarity comparison or proof that every dependency is original.

- `6e00131` (2026-05-16): initial sanitized POC platform, including native manifest verification.
- `e32275e` (2026-08-12): iOS handoff card, Continue and push routing.
- `dca03d4` (2026-08-13): clearer handoffs and simulator preview work.
- `a9699ae` (2026-08-18): result and localhost preview rendering.

If the signed catalog is safely provisioned and verified for the reviewer, an optional description paragraph is:

> For configured prototype libraries, Relay verifies a signed catalog before listing published prototypes and opens them in its authenticated in-app viewer. Libraries require their own provisioning; access to a Relay Hosted machine alone does not grant library access.

Do not add it to the listing until that is genuinely a supported customer-facing setup, not merely a developer-only legacy capability.

## Screenshot sequence

Capture real app UI on a supported device/simulator in the replacement build. Use a dedicated fictional/synthetic review project, not private user conversations, real account information, arbitrary mocked screenshots or fabricated response/approval data. Captions are optional; keep the UI visible. The app should visibly explain any staged example data, and App Review must get the same accessible functions.

1. **Workspace results:** Previews with Workspace results selected, showing real outputs and their project/task context. Use the actual built screen, not a workspace-overview mockup.
2. **Open the working result:** real task output opened in Relay's in-app web preview. Keep enough native context to establish it is the app, and use non-sensitive prototype content.
3. **Pick up a handoff:** a genuine handoff card with source context and Continue. Only use this if the review account has a compatible prepared handoff; otherwise use actual file inspection here.
4. **Inspect files and changes:** a real project file or completed run's relevant output, clearly tied to the workspace.
5. **Review a decision:** actual pending approval with an innocuous requested action, if a safe fixture exists; otherwise Sessions showing the prepared completed and active task history.
6. **Control what is shared:** the actual provider-specific AI Data Sharing sheet, with content categories and Not Now/Allow visible.
7. **Choose a machine:** actual Settings/onboarding screen explaining own hardware and Relay Hosted. Subscription/paywall, if included, goes last and must not obscure that provider access is separate. Published catalog details may be an additional screenshot only if the shown catalog and its entries are safely authorized and reviewer-accessible.

Capture both iPhone and iPad if layouts differ. Check the requested App Store Connect display classes rather than assuming that the older 1284×2778 files cover every requirement. Keep existing untracked `artifacts/app-store-1.0/` untouched unless separately authorized.

## Before posting or submitting

- Resolve the attached replacement build and source commit; verify it processed successfully and was not built with an ineligible beta toolchain.
- Confirm the new navigation/copy exists in the actual Release binary and shared-mobile changes meet the parity contract.
- Log in through the exact existing review route. Confirm the prepared workspace and its files, handoff (if claimed), task, live local preview and supported approval state are accessible. Record their non-secret names in review notes.
- Keep review data on the existing isolated review machine. Do not mount the operator's private signed catalog or copy provider credentials to satisfy review.
- Verify the advertised local preview does not expire or disappear before review; its source development service must be deliberately maintained as part of the prepared review fixture.
- Test switching account, changing machine and replacing/removing its identity while a result/catalog load is in flight. Old result rows, open viewers and verification state must not appear in the new context. Source code now resets the iOS root by account/machine and invalidates catalog requests; Android uses a connection revision, cancellation and stale-result guards. These are implementation observations, not a claim that runtime boundary tests passed.
- Recheck description character limits after any edits, screenshots for factual agreement with the binary, all current legal/support URLs, and consent accessibility while disconnected.
- Preserve the existing Apple Standard EULA link exactly: `https://www.apple.com/legal/internet-services/itunes/dev/stdeula/`. The service terms link can be additional; it must not replace the standard EULA configured in App Information.
- Replace only the rejected build. Preserve valid subscription review items and manual-release setting. Reply while the rejected submission still permits a response, then resubmit and independently reread every item's status.

## Apple guidance checked

The metadata and screenshot plan follows Apple's requirement that the listing reflect the actual app and screenshots show it in use; current guideline 4.3 also addresses repetitive or indistinguishable apps. A different name alone is not presented here as a cure. [App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)

Apple recommends clear review access and final, working content; the fixture verification above is required before representing the workflow as reviewer-accessible. [App Review preparation](https://developer.apple.com/app-store/review/)

Apple allows screenshots to be replaced while a version is Rejected, and supports one to ten screenshots per set. [Upload app previews and screenshots](https://developer.apple.com/help/app-store-connect/manage-app-information/upload-app-previews-and-screenshots)

## Evidence limits

This remediation makes real functionality easier to inspect and presents it more accurately. It does not establish that competing products lack these features, prove global binary originality, or guarantee acceptance under 4.3. The review reply asks Apple for the particular material or functionality they consider duplicated if the concern remains. Build processing success, screenshot upload success and a queued review are also not approval.

Do not describe both mobile apps as fully equivalent: Android still uses its existing manual-machine/certificate setup and does not acquire iOS hosted-account onboarding from this change. The shared Previews behavior has parallel implementations with documented native UI differences.
