# Relay App Review 4.3 remediation

Prepared 2026-08-30 for App Store Connect app `6800257362`, bundle `com.parikshit.pocvault`, version `1.0`. Historical checkpoints are retained below. The August 31 submission checkpoint is the latest state: build 49 replaced rejected build 38, and the app plus all subscription/group items reached Waiting for Review.

The rejected build 38 and generic 4.3(a) feedback were supplied by the release owner. This document's implementation findings were checked against the local source tree. It does not claim live review-account, deployed-service, screenshot, or replacement-binary verification.

## Release checkpoint — 2026-08-31

The implementation is pushed as `85f1eceaf7258280f18847d0c06612e2ecf8602e`.
Xcode Cloud build **47** (`7187b650-e0ff-49f0-8a27-efc4695d54ab`) has
live-verified **Succeeded** results for Test — iOS, Archive — iOS, and TestFlight
Internal Testing. This is not evidence of an attached App Store build or a
resubmitted review. No Apple listing, screenshot, review reply, or submission
was changed at this checkpoint.

The five native screenshot candidates under `artifacts/app-store-4.3/iphone/`
use the local, explicitly fictional fixture. See that artifact directory's
README for provenance. The equivalent prepared task has **not** been verified
on the live review account, so the reviewer reply must not claim it exists.

### Live reviewer-access blocker

Saved review credentials authenticated successfully against the production
account service. Account, node-list, current-trial, and device-link reads all
returned HTTP 200. The trial is marked `upgraded` and points to an owned node,
but the exact sandbox lookup returned HTTP 404 with `sandbox ... not found`;
the HTTP-200 sandbox list also omitted that sandbox. Both node health paths
reset their connections. Do not represent this as a temporary login failure.

The trial was created on 2026-08-19 at 08:39 UTC; its node's last heartbeat was
2026-08-29 at 09:39 UTC. This matches the default seven-day trial plus three-day
grace plus one-hour platform timeout. Source inspection found that App Review
auto-upgrade changes only registry state/entitlements, while paid subscription
activation extends or resumes the platform sandbox. The timing and source are
strong evidence of an unchanged platform-expiry timer, not a recovered machine.

Separately, a fresh installation cannot recover credentials for the existing
upgraded node: `RelayTrialFlowModel.adoptExistingTrial` accepts only ready trials
and requires locally retained identity/token material. Accepting `upgraded`
alone is insufficient. Rerunning the current pair-only operation is not a safe
multi-device fix: it replaces the single device-token hash before delivery and
can invalidate an existing phone.

Next recovery must be explicitly scoped: determine whether any sandbox data
can be recovered, authorize replacement if needed, correct hosted lifetime
handling, and use a securely ownership-bound fresh-device pairing flow. Do not
delete the stale registry row, revoke devices, copy operator credentials, or
promise a ready workspace merely to unblock review. No sandbox, registry,
account, password, or production service was mutated during these diagnostics.

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

The release owner's final configuration/runtime check found `TARGETED_DEVICE_FAMILY=1` in Debug and Release and `UIDeviceFamily=[1]` in the built app. Relay currently targets **iPhone**, not native iPad. On iPad it runs in iPhone compatibility mode, including the observed black side margins; passing tests on an iPad simulator does not establish native iPad support. The listing therefore says iPhone only. Do not change the device family as part of this metadata fix.

Capture and upload the required iPhone screenshot sets. Skip iPad uploads unless App Store Connect explicitly requires a compatibility screenshot; any such image must show the actual compatibility-mode app, not imply a native iPad layout. Check the requested App Store Connect display classes rather than assuming that the older 1284×2778 files cover every requirement. Keep existing untracked `artifacts/app-store-1.0/` untouched unless separately authorized.

## Before posting or submitting

- Resolve the attached replacement build and source commit; verify it processed successfully and was not built with an ineligible beta toolchain.
- Confirm the new navigation/copy exists in the actual Release binary and shared-mobile changes meet the parity contract.
- Keep platform claims aligned with the binary's iPhone-only device family. Do not describe the compatibility-mode iPad test run as native iPad validation.
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

## August 31 live recovery checkpoint

- Runtime source: `2e64546793a1aa67218bbdf73c23e84a4793cb0a`. Follow-up test-packaging commits culminate in `80f34cc0bd66f70ea2c876b81208e462eedd98cb`; iOS, cloud runtime, relayd and trial runtime trees are unchanged between them.
- Cloud release `80f34cc` deployed to the existing Relay service. All 81 tracked cloud files matched the clean archive; database integrity, protected API responses and shared-host services passed. Previous release `c27e8267c8c72afedbfd2fa7125bac22739099a4` remains available for rollback.
- New hosted template `tpl-9279dcbf18ff4619a1f267e2` is READY and selected. Previous template `tpl-5ee31078ced448f4bac53f20` is retained and recorded in the existing rollback-pointer file. Other user machines were not replaced.
- The exact stale reviewer registration was removed after backup and authorization; it had zero handoffs and zero sync notices. The replacement was created through the normal account trial API. Credential collection promoted it to upgraded access only after the platform timer was extended. The live platform returned running with end time `2027-09-04T19:08:41.654Z`, beyond the normal trial deadline.
- Initial and fresh-device encrypted pairing both delivered MAC-verified credential blobs; both independent bearers returned 200. Revoking only the temporary recovery-verification device returned 200, made that bearer return 401, and left the original verification credential working. No operator provider credentials were copied; all four installed providers reported logged out.
- Normal authenticated APIs returned the explicitly preloaded Launch checklist example, its real artifact and workspace. Artifact bytes exactly match the checked-in sample; unauthenticated artifact/job requests returned 401. Static preview and task-bound working page returned 200. Revoking the temporary preview lease returned 204 and made its capability return 404. Native interaction/screenshots are still a separate verification gate.
- Verification: daemon 509/509; monorepo cloud 388/388; real cross-product encrypted integration 1/1; clean standalone cloud on Node 22 has 385 passes, zero failures and one pre-existing cross-product skip; trial/sample tests 15/15; full iOS suite 221 plus final focused 37/37; Release Simulator build succeeded. Mobile parity CI `33329667831` succeeded for contract, Android/shared core and iOS.
- Xcode Cloud build 48 (`92000728-e892-48e4-8788-ad536a50e994`) from `2e64546` succeeded for tests, archive and TestFlight delivery using stable Xcode 26.6. TestFlight build `9345b1a8-187c-4a58-a042-4748467920e1` is processed and Ready to Submit. This is not yet evidence of App Review submission.
- Remaining: user confirmation for entering saved demo credentials on the clean test iPhone, native live screenshots/interaction, coherent reviewer-password rotation/update, final listing/review-note verification, replacement-build attachment, reviewer reply and submission. No Apple metadata, screenshots, build attachment, reply or submission were changed during this recovery checkpoint. Keep the existing manual-release setting and valid subscription review items.

## August 31 final native-verification checkpoint

- The user authorized using the saved reviewer credentials on the dedicated fresh iPhone simulator. Login and production hosted-device recovery succeeded. No operator provider credentials were used. The initial unsigned Simulator-only Keychain error was resolved by building with the normal simulated signing entitlements; no product signing settings or custom keychain groups were introduced.
- Live native verification exposed a cold-load source-job issue: provider-model discovery delayed presentation of a job that Previews already had. Runtime commit `b2d34d81cc61db51f95a7f04e3de4fa3dea3b86a` now presents the real supplied job immediately and asynchronously refreshes detail, guarded by conversation revisions. Regression cases cover a slow response, a new conversation and reselection of the same source job. The focused suite passed 4/4 and the full iOS suite passed 226/226; the signed Release Simulator build succeeded.
- The rebuilt Release app was installed without deleting the reviewer account. View source job showed the source prompt and completed job in the first UI state read, approximately 1.1 seconds after the click, rather than waiting for provider discovery. Its full preloaded-example explanation, artifact and live-app action were verified. No new AI run was executed.
- The task-linked live page loaded through the production node and its checkbox changed the count from 2 of 3 to 3 of 3. Native Workspaces listed `launch-checklist.html` and `README.md`. Settings visibly provided Monthly/Yearly subscriptions, Restore Purchases and Delete account; purchase, restoration and deletion were not executed. The provider disclosure was inspected and declined with Not Now.
- Five unedited 1320 x 2868 screenshots from this final Release binary and real reviewer machine are in `artifacts/app-store-4.3/iphone-live/`, with a provenance README. All PNGs were visually inspected. They replace the earlier local-fixture candidates for the planned Apple package, but have not been uploaded.
- Android already renders the supplied source-job snapshot synchronously on its separate job-detail screen, without waiting for completed-job detail or provider discovery. Parity-only commit `27c25f5ca894a12573946467f9fe0bb3282ddc0d` documents that reviewed platform implementation difference and strengthens evidence checks; it changes no runtime source. Remote main was verified at that SHA. The parity contract passes against the original base and current change; CI run `33330774326` completed successfully for all three jobs: contract, Android and iOS.
- Xcode Cloud replacement build **49**, ID `723c7adb-2eae-4d30-96db-92cf13925cad`, explicitly references runtime commit `b2d34d8` and stable Xcode 26.6 (17F113), macOS 26.6.2. At the last readable Apple state, Test and Archive were running and TestFlight delivery was queued. Build 48 remains an older processed fallback, not the intended final fix. Do not attach 49 until its processing succeeds.
- Review notes were finalized locally with the verified sample labels and established subscription instructions; operator placeholders were removed. The public description retains the Apple Standard EULA and accurate work-content privacy qualification. Nothing was posted to Apple.
- The Mac locked during the next App Store Connect check, and Computer Use reported that automatic unlock could not unlock it. User unlock is required. The action-time confirmation for saving the revised listing/screenshots/reviewer instructions, sending the reviewer reply and submitting is also unanswered. No Apple metadata, screenshot, review credential, build attachment, reply or submission was changed. The reviewer password still requires coherent private rotation and saved-field update before submission. Do not print it.
- The user requested laptop sleep only after submission. No sleep command was issued, since the submission is not yet verified. Next: unlock and confirm the Apple write, verify build 49 and CI, rotate/update the dedicated reviewer password privately, save/verify the package and manual release, reply, resubmit, and reread the app plus all three subscription/group items before sleeping the Mac.

## August 31 submission checkpoint — submitted

- App Store Connect app `6800257362`, bundle `com.parikshit.pocvault`, team `QRXV2V66Y6`, version **1.0**, build **49**. Runtime source is `b2d34d81cc61db51f95a7f04e3de4fa3dea3b86a`; parity-only follow-up `27c25f5ca894a12573946467f9fe0bb3282ddc0d` changes no binary source. Xcode Cloud build `723c7adb-2eae-4d30-96db-92cf13925cad` succeeded for tests, archive and TestFlight delivery on stable Xcode 26.6. Processed TestFlight build `94d67000-2476-4278-bf08-051165e30153` was verified Ready to Submit before attachment.
- The user confirmed saving the review package, sending the reply and submitting. Saved and independently reloaded: app name **Relay: Workspaces & Previews**, subtitle **Results, files and handoffs**, description, promotional text, keywords and finalized reviewer instructions. Existing legal declarations, contacts, subscription prices and manual release were preserved.
- The dedicated reviewer password was rotated privately and the replacement login returned HTTP 200. A browser paste mismatch briefly put a now-invalidated password into unsaved public text fields. Those fields were corrected using direct field assignment, the affected credential was rotated again, its old login returned HTTP 401, and all public fields plus the private sign-in fields were verified after saving and reloading. No valid credential was included in the posted public metadata or reviewer reply. Account sessions were revoked by the password rotation; the hosted machine's separate device credentials were not revoked. Its authenticated jobs endpoint returned HTTP 200 with the real starter task present.
- Uploaded the five live screenshot PNGs from `iphone-live/`, verified their persisted 01–05 order, and removed only the obsolete Apple 6.9-inch and 6.5-inch sets. Every smaller iPhone display class was checked and uses the new 6.9-inch set. Local screenshot sources and the user's unrelated `artifacts/app-store-1.0/` remain untouched.
- Replaced build 38 with build 49 and independently reloaded the version: exact build, all prepared public text, private reviewer credentials and **Manually release this version** matched. Sent the prepared 4.3 response naming version 1.0 build 49; Apple's thread increased from six to seven messages and the posted response was visible. Updated the rejected app item, verified all four items Ready for Review, then resubmitted.
- Submission **`7ec71a43-ef40-4926-9c17-786e9f393fb1`** now shows **Waiting for Review**, with Date Submitted **Aug 31, 2026 at 7:55 AM** in the account UI. App **1.0 (49)**, **Relay Hosted**, **Relay Hosted Monthly** and **Relay Hosted Yearly** each individually show **Waiting for Review**. An independent browser reload confirmed the overall state, all four item states, build 49 and the posted reply. This is submission, not Apple approval or public release. No queued submission was canceled.
- Source fixes and parity review are pushed. The evidence document, finalized local review-note draft and screenshot artifacts remain uncommitted; unrelated user artifacts were preserved. Laptop sleep is authorized only after the final queue verification.
