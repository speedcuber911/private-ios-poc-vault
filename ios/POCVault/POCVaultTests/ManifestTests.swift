import CryptoKit
import XCTest
import AVFoundation
import SwiftUI
@testable import POCVault

final class ManifestTests: XCTestCase {
    func testDecodesManifestEntriesWithISO8601Dates() throws {
        let json = """
        {
          "schemaVersion": 1,
          "generatedAt": "2026-05-15T10:00:00Z",
          "pocs": [
            {
              "slug": "smoke",
              "title": "Smoke Test",
              "description": "Small internal POC",
              "url": "https://smoke.pocs.example.com/",
              "updatedAt": "2026-05-14T09:30:00Z",
              "tags": ["demo", "ios"]
            }
          ]
        }
        """.data(using: .utf8)!

        let manifest = try POCManifest.decode(from: json)

        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.entries.first?.id, "smoke")
        XCTAssertEqual(manifest.entries.first?.displayHost, "smoke.pocs.example.com")
        XCTAssertEqual(manifest.entries.first?.requiresClientCertificate, true)
    }

    func testSearchMatchesTitleSummaryAndTags() throws {
        let entry = POCEntry(
            id: "alpha",
            title: "Forecast Console",
            summary: "Demand planner prototype",
            url: URL(string: "https://poc-vault.test/forecast")!,
            updatedAt: nil,
            tags: ["sales"],
            requiresClientCertificate: false
        )

        XCTAssertTrue(entry.matchesSearch("forecast"))
        XCTAssertTrue(entry.matchesSearch("planner"))
        XCTAssertTrue(entry.matchesSearch("sales"))
        XCTAssertFalse(entry.matchesSearch("finance"))
    }

    func testEd25519SignatureVerificationUsesRawPublicKeyBytes() throws {
        let privateKey = Curve25519.Signing.PrivateKey()
        let payload = Data("manifest".utf8)
        let signature = try privateKey.signature(for: payload)

        XCTAssertTrue(
            ManifestClient.verifySignature(
                payload: payload,
                signature: signature,
                publicKeyRawRepresentation: privateKey.publicKey.rawRepresentation
            )
        )
        XCTAssertFalse(
            ManifestClient.verifySignature(
                payload: Data("tampered".utf8),
                signature: signature,
                publicKeyRawRepresentation: privateKey.publicKey.rawRepresentation
            )
        )
    }

    func testCodexErrorSummaryExtractsHttpStatusAndHtmlMessage() throws {
        let rawMessage = """
        Codex request failed with HTTP 404: <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"
        "http://www.w3.org/TR/html4/strict.dtd">
        <html>
        <body>
        <h1>Error response</h1>
        <p>Error code: 404</p>
        <p>Message: Not Found.</p>
        <p>Error code explanation: 404 - Nothing matches the given URI.</p>
        </body>
        </html>
        """

        let summary = CodexErrorSummary(message: rawMessage)

        XCTAssertEqual(summary.statusCode, 404)
        XCTAssertEqual(summary.statusLine, "HTTP 404")
        XCTAssertEqual(summary.summary, "Not Found")
        XCTAssertTrue(summary.rawResponse.contains("<!DOCTYPE HTML"))
    }

    func testCodexErrorSummaryUsesPlainTextWhenNoStructuredPayloadExists() throws {
        let summary = CodexErrorSummary(message: "No Codex workspace is available.")

        XCTAssertNil(summary.statusCode)
        XCTAssertEqual(summary.statusLine, "Request failed")
        XCTAssertEqual(summary.summary, "No Codex workspace is available.")
        XCTAssertEqual(summary.rawResponse, "No Codex workspace is available.")
    }

    func testCodexJobDisplayOutputPrefersSingleResultWhenStreamsDuplicate() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-1",
              "status": "succeeded",
              "prompt": "Summarize the repo",
              "result": "The repo is healthy.",
              "stdout": "The repo is healthy.",
              "stderr": "The repo is healthy.",
              "model": "gpt-5.5",
              "reasoningEffort": "high"
            }
            """
        )

        XCTAssertEqual(job.displayOutput, "The repo is healthy.")
        XCTAssertEqual(job.model, "gpt-5.5")
        XCTAssertEqual(job.reasoningEffort, "high")
    }

    func testCodexProviderDefaultsAreProviderSpecific() throws {
        XCTAssertEqual(CodexProvider.defaultProvider, .codex)
        XCTAssertEqual(CodexProvider.codex.displayName, "Codex")
        XCTAssertEqual(CodexProvider.codex.defaultModel, "gpt-5.5")
        XCTAssertEqual(CodexProvider.codex.defaultReasoningEffort, .xhigh)

        XCTAssertEqual(CodexProvider.claude.displayName, "Claude")
        XCTAssertEqual(CodexProvider.claude.defaultModel, "sonnet")
        XCTAssertEqual(CodexProvider.claude.defaultReasoningEffort, .high)
        XCTAssertEqual(CodexProvider.claude.reasoningEffortOptions, CodexReasoningEffort.allCases)
    }

    func testCodexProviderTabIconsUseBrandAssets() throws {
        XCTAssertEqual(CodexProvider.codex.tabIconAssetName, "ChatGPTMark")
        XCTAssertEqual(CodexProvider.claude.tabIconAssetName, "ClaudeMark")
    }

    func testRelayDesignTokensUseWarmRedesignPalette() throws {
        assertColor(AppTheme.bgCanvas, red: 0x1A, green: 0x19, blue: 0x17, alpha: 1)
        assertColor(AppTheme.bgSurface, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.06)
        assertColor(AppTheme.bgSurfaceHi, red: 0x23, green: 0x22, blue: 0x20, alpha: 1)
        assertColor(AppTheme.textPrimary, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 1)
        assertColor(AppTheme.textSecondary, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.45)
        assertColor(AppTheme.textTertiary, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.27)
        assertColor(AppTheme.accent, red: 0xD4, green: 0x80, blue: 0x4A, alpha: 1)
        assertColor(AppTheme.statusOK, red: 0x32, green: 0xD7, blue: 0x4B, alpha: 1)
        assertColor(AppTheme.statusWarn, red: 0xFF, green: 0x9F, blue: 0x0A, alpha: 1)
    }

    func testConsoleControlStripLayoutIsRemovedFromHomeComposer() throws {
        let codexLayout = CodexControlStripLayout(provider: .codex)
        let claudeLayout = CodexControlStripLayout(provider: .claude)

        XCTAssertEqual(codexLayout.visibleRowCount, 0)
        XCTAssertEqual(claudeLayout.visibleRowCount, codexLayout.visibleRowCount)
        XCTAssertEqual(codexLayout.controlHeight, 0)
        XCTAssertEqual(claudeLayout.controlHeight, codexLayout.controlHeight)
        XCTAssertFalse(codexLayout.showsSkillButton)
        XCTAssertFalse(claudeLayout.showsSkillButton)
        XCTAssertFalse(claudeLayout.reservesSkillSlot)
        XCTAssertFalse(codexLayout.showsRunMode)
        XCTAssertFalse(claudeLayout.showsRunMode)
    }

    func testThreadDetailLayoutKeepsActiveRunChromeOutOfChatFlow() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "thread-active",
              "sessionId": "thread-active",
              "workspaceName": "POC Vault",
              "activeJobCount": 1,
              "lastJobId": "job-active",
              "lastJobStatus": "running",
              "lastPrompt": "Review and merge if all good"
            }
            """
        )

        let layout = CodexThreadDetailLayout(thread: thread)

        XCTAssertTrue(thread.hasActiveJobs)
        XCTAssertEqual(layout.contentSections, [.overview, .chatTranscript])
        XCTAssertFalse(layout.showsInlineProgressCard)
        XCTAssertTrue(layout.showsLatestRunToolbarButton)
    }

    func testThreadDetailComposerIsInlineAboveRootTabBar() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        guard
            let detailStart = source.range(of: "private struct CodexThreadDetailView: View"),
            let composerStart = source.range(of: "private struct CodexThreadComposerDock: View")
        else {
            return XCTFail("Expected thread detail and composer views in CodexConsoleView.swift")
        }

        let detailSource = String(source[detailStart.lowerBound..<composerStart.lowerBound])

        XCTAssertTrue(detailSource.contains("CodexThreadComposerDock("))
        XCTAssertTrue(detailSource.contains("replyComposerTabBarClearance"))
        XCTAssertFalse(detailSource.contains(".safeAreaInset(edge: .bottom)"))
    }

    func testThreadDetailRendersChatTranscriptAndKeepsComposerNearTabBar() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let detailSource = try sourceSnippet(
            in: source,
            from: "private struct CodexThreadDetailView: View",
            to: "private struct CodexThreadDetailNavBar: View"
        )

        XCTAssertTrue(detailSource.contains("CodexThreadChatTranscriptView("))
        XCTAssertFalse(detailSource.contains("CodexThreadResponseCard("))
        XCTAssertTrue(detailSource.contains("private static let replyComposerTabBarClearance: CGFloat = 16"))
    }

    func testThreadDetailPullToRefreshDoesNotFetchFullLogsOrShowCancellation() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let detailSource = try sourceSnippet(
            in: source,
            from: "private struct CodexThreadDetailView: View",
            to: "private struct CodexThreadDetailNavBar: View"
        )
        let refreshSource = try sourceSnippet(
            in: detailSource,
            from: ".refreshable {",
            to: ".task(id: routeIdentity)"
        )
        let loadThreadDetailSource = try sourceSnippet(
            in: detailSource,
            from: "private func loadThreadDetail() async",
            to: "private func loadLatestJob"
        )
        let loadLatestJobSource = try sourceSnippet(
            in: detailSource,
            from: "private func loadLatestJob",
            to: "private func selectResolvedSessionIfAvailable"
        )

        XCTAssertTrue(refreshSource.contains("await refreshThreadDetailAndLatestJob()"))
        XCTAssertFalse(refreshSource.contains("includeFullLogs: true"))
        XCTAssertTrue(loadThreadDetailSource.contains("CodexConsoleViewModel.isCancellation(error)"))
        XCTAssertTrue(loadLatestJobSource.contains("CodexConsoleViewModel.isCancellation(error)"))
    }

    func testThreadDetailNavOmitsRedundantRefreshButton() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let detailSource = try sourceSnippet(
            in: source,
            from: "private struct CodexThreadDetailView: View",
            to: "private struct CodexThreadDetailNavBar: View"
        )
        let navSource = try sourceSnippet(
            in: source,
            from: "private struct CodexThreadDetailNavBar: View",
            to: "private struct CodexThreadResponseCard: View"
        )

        XCTAssertFalse(detailSource.contains("onRefresh:"))
        XCTAssertFalse(navSource.contains("let onRefresh"))
        XCTAssertFalse(navSource.contains("Button(action: onRefresh)"))
        XCTAssertFalse(navSource.contains("arrow.clockwise"))
        XCTAssertTrue(navSource.contains("terminal"))
    }

    func testRootUsesNativeLiquidGlassTabView() throws {
        let source = try String(contentsOfFile: appSourcePath, encoding: .utf8)

        XCTAssertTrue(source.contains("TabView(selection: $selectedTab)"))
        XCTAssertTrue(source.contains(".tabItem"))
        XCTAssertFalse(source.contains("RelayTabBar"))
        XCTAssertFalse(source.contains("safeAreaInset(edge: .bottom"))
        XCTAssertFalse(source.contains("configureWithOpaqueBackground"))
    }

    func testCodexClaudeHomePolishUsesSharedCompactComponents() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)

        let screenSource = try sourceSnippet(
            in: source,
            from: "struct CodexConsoleView: View",
            to: "private enum CodexRoute: Hashable"
        )
        XCTAssertFalse(screenSource.contains("CodexContextLine(viewModel"))

        let contextSource = try sourceSnippet(
            in: source,
            from: "private struct CodexContextLine: View",
            to: "private struct CodexPromptCard: View"
        )
        XCTAssertFalse(contextSource.contains("selectedThreadID"))

        let promptSource = try sourceSnippet(
            in: source,
            from: "private struct CodexPromptCard: View",
            to: "private struct CodexComposeStatusPanel: View"
        )
        XCTAssertTrue(promptSource.contains("attachedComposerHeader"))
        XCTAssertTrue(promptSource.contains("largePromptEditor"))
        XCTAssertTrue(promptSource.contains("promptEditorMinHeight"))
        XCTAssertTrue(promptSource.contains("TextEditor("))
        XCTAssertTrue(promptSource.contains("CodexAttachmentMenu("))
        XCTAssertTrue(promptSource.contains("mic.fill"))
        XCTAssertTrue(promptSource.contains("arrow.up"))
        XCTAssertFalse(promptSource.contains("selectedThreadID"))

        let previewSource = try sourceSnippet(
            in: source,
            from: "private struct CodexComposeStatusPanel: View",
            to: "private struct CodexSessionSettingsSheet: View"
        )
        XCTAssertTrue(previewSource.contains("threadPreviewBackground"))
        XCTAssertTrue(previewSource.contains("threadPreviewSeparator"))
        XCTAssertTrue(previewSource.contains("statusPillBackground"))

        let feedSource = try sourceSnippet(
            in: source,
            from: "private struct CodexThreadFeedSection: View",
            to: "private struct CodexThreadFeedRow: View"
        )
        XCTAssertTrue(feedSource.contains("CodexLowThreadCountHint"))

        let rowSource = try sourceSnippet(
            in: source,
            from: "private struct CodexThreadFeedRow: View",
            to: "private struct CodexStatusChip: View"
        )
        XCTAssertTrue(rowSource.contains("exclamationmark.circle"))
        XCTAssertTrue(rowSource.contains("AppTheme.statusWarn"))
    }

    func testPromptModuleHeaderIsIntegratedNotOvalPill() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let promptSource = try sourceSnippet(
            in: source,
            from: "private struct CodexPromptCard: View",
            to: "private struct CodexComposeStatusPanel: View"
        )

        XCTAssertTrue(promptSource.contains("private static let composerModuleCornerRadius: CGFloat = 14"))
        XCTAssertTrue(promptSource.contains("private static let composerHeaderMinHeight: CGFloat = 54"))
        XCTAssertTrue(promptSource.contains(".frame(minHeight: Self.composerHeaderMinHeight)"))
        XCTAssertTrue(promptSource.contains(".contentShape(Rectangle())"))
        XCTAssertFalse(promptSource.contains(".background(AppTheme.textPrimary.opacity(0.045))"))
        XCTAssertFalse(promptSource.contains("RoundedRectangle(cornerRadius: 18, style: .continuous)"))
    }

    func testSessionSettingsUsesInlineQuickPickPills() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let sheetSource = try sourceSnippet(
            in: source,
            from: "private struct CodexSessionSettingsSheet: View",
            to: "private struct CodexSettingsChoiceSection"
        )

        XCTAssertTrue(sheetSource.contains("Text(\"Agent settings\")"))
        XCTAssertTrue(sheetSource.contains("CodexSettingsChoiceSection("))
        XCTAssertTrue(sheetSource.contains("CodexSettingsPill("))
        XCTAssertTrue(sheetSource.contains("ForEach(viewModel.modelOptions"))
        XCTAssertTrue(sheetSource.contains("ForEach(viewModel.reasoningEffortOptions"))
        XCTAssertTrue(sheetSource.contains("ForEach(CodexRunMode.allCases"))
        XCTAssertTrue(sheetSource.contains("quickSkillOptions"))
        XCTAssertFalse(sheetSource.contains("repositoryQuickPickSection"))
        XCTAssertFalse(sheetSource.contains("quickWorkspaceOptions"))
        XCTAssertFalse(sheetSource.contains("title: \"Repository\""))
        XCTAssertFalse(sheetSource.contains("Menu {"))
        XCTAssertFalse(sheetSource.contains("CodexSettingsRowContent(symbol: \"cpu\""))
        XCTAssertFalse(sheetSource.contains("CodexSettingsRowContent(symbol: \"slider.horizontal.3\""))
        XCTAssertFalse(sheetSource.contains("CodexSettingsRowContent(symbol: \"sun.max\""))
        XCTAssertFalse(source.contains("private struct CodexSettingsRowContent: View"))
    }

    func testWorkspacePickerIsTopLevelPromptHeaderControl() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let promptSource = try sourceSnippet(
            in: source,
            from: "private struct CodexPromptCard: View",
            to: "private struct CodexComposeStatusPanel: View"
        )

        XCTAssertTrue(promptSource.contains("@State private var showingWorkspacePicker = false"))
        XCTAssertTrue(promptSource.contains("workspaceHeaderControl"))
        XCTAssertTrue(promptSource.contains("agentSettingsHeaderControl"))
        XCTAssertTrue(promptSource.contains("showingWorkspacePicker = true"))
        XCTAssertTrue(promptSource.contains("CodexWorkspacePickerSheet(viewModel: viewModel)"))
        XCTAssertTrue(promptSource.contains("accessibilityLabel(\"Choose repository\")"))
        XCTAssertTrue(promptSource.contains("accessibilityLabel(\"Agent settings\")"))
        XCTAssertFalse(promptSource.contains("Text(viewModel.composeWorkspaceLabel)\n                    .font(.system(size: 14, weight: .medium))\n                    .foregroundStyle(AppTheme.accent)\n                    .lineLimit(1)\n                Text(\"·\")"))
    }

    func testWorkspacePickerUsesBrowseFirstFilesStyleSheet() throws {
        let source = try String(contentsOfFile: codexConsoleSourcePath, encoding: .utf8)
        let sheetSource = try sourceSnippet(
            in: source,
            from: "private struct CodexWorkspacePickerSheet: View",
            to: "private struct CodexWorkspaceLoadingRow: View"
        )
        let rowSource = try sourceSnippet(
            in: source,
            from: "private struct CodexWorkspaceDirectoryRow: View",
            to: "private struct CodexAttachmentMenu: View"
        )

        XCTAssertTrue(sheetSource.contains("Text(\"Choose workspace\")"))
        XCTAssertTrue(sheetSource.contains("workspaceSearchField"))
        XCTAssertTrue(sheetSource.contains("workspaceLocationBar"))
        XCTAssertTrue(sheetSource.contains("workspaceFolderList"))
        XCTAssertTrue(sheetSource.contains("workspaceFooterActions"))
        XCTAssertTrue(sheetSource.contains("Text(\"Use this folder\")"))
        XCTAssertTrue(sheetSource.contains(".refreshable"))
        XCTAssertTrue(sheetSource.contains("selectCurrentFolder()"))
        XCTAssertTrue(sheetSource.contains("showingCreateFolder = true"))
        XCTAssertTrue(sheetSource.contains("viewModel.loadWorkspaceDirectories(path: listing?.currentPath, query: currentSearchQuery)"))
        XCTAssertFalse(sheetSource.contains("NavigationStack"))
        XCTAssertFalse(sheetSource.contains(".navigationTitle(\"Workspace Folder\")"))
        XCTAssertFalse(sheetSource.contains(".toolbar"))
        XCTAssertFalse(sheetSource.contains("Refresh workspace folders"))
        XCTAssertFalse(sheetSource.contains("Create workspace folder"))
        XCTAssertFalse(sheetSource.contains("Label(\"Up\""))
        XCTAssertFalse(sheetSource.contains("Label(viewModel.isSelectingWorkspaceDirectory ? \"Selecting\" : \"Select\""))

        XCTAssertTrue(rowSource.contains("Button(action: onBrowse)"))
        XCTAssertTrue(rowSource.contains("Image(systemName: \"chevron.right\")"))
        XCTAssertTrue(rowSource.contains("Text(\"Registered\")"))
        XCTAssertTrue(rowSource.contains("Text(\"Git\")"))
        XCTAssertFalse(rowSource.contains("let onSelect"))
        XCTAssertFalse(rowSource.contains("Text(\"Select\")"))
        XCTAssertFalse(rowSource.contains("accessibilityLabel(\"Select"))
    }

    func testCodexJobDefaultsMissingProviderToCodexAndDecodesClaude() throws {
        let legacyJob = try decodeCodexJob(
            """
            {
              "id": "job-legacy",
              "status": "succeeded"
            }
            """
        )
        let claudeJob = try decodeCodexJob(
            """
            {
              "id": "job-claude",
              "status": "running",
              "provider": "claude"
            }
            """
        )

        XCTAssertEqual(legacyJob.provider, .codex)
        XCTAssertEqual(claudeJob.provider, .claude)
    }

    func testCodexJobDisplayOutputUsesErrorForFailedJobs() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-2",
              "status": "failed",
              "prompt": "Run tests",
              "stderr": "xcodebuild exited 65",
              "error": "codex exited with code 1"
            }
            """
        )

        XCTAssertEqual(job.displayOutput, "codex exited with code 1")
        XCTAssertTrue(job.rawActivityOutput?.contains("xcodebuild exited 65") == true)
    }

    func testCodexJobDecodesArtifactsAndDefaultsMissingArtifactsToEmpty() throws {
        let legacyJob = try decodeCodexJob(
            """
            {
              "id": "job-no-artifacts",
              "status": "succeeded",
              "result": "Plain answer"
            }
            """
        )
        XCTAssertTrue(legacyJob.artifacts.isEmpty)

        let job = try decodeCodexJob(
            """
            {
              "id": "job-artifacts",
              "status": "succeeded",
              "result": "Here is the app",
              "artifacts": [
                {
                  "id": "artifact-001",
                  "kind": "staticPreview",
                  "filename": "index.html",
                  "title": "index html",
                  "language": "html",
                  "contentType": "text/html; charset=utf-8",
                  "bytes": 42,
                  "rawURL": "/v1/codex/jobs/job-artifacts/artifacts/artifact-001/raw",
                  "previewURL": "/v1/codex/jobs/job-artifacts/artifacts/artifact-001/preview"
                }
              ]
            }
            """
        )

        XCTAssertEqual(job.artifacts.count, 1)
        XCTAssertEqual(job.artifacts[0].id, "artifact-001")
        XCTAssertEqual(job.artifacts[0].kind, .staticPreview)
        XCTAssertEqual(job.artifacts[0].filename, "index.html")
        XCTAssertEqual(job.artifacts[0].language, "html")
        XCTAssertEqual(job.artifacts[0].bytes, 42)
        XCTAssertEqual(job.artifacts[0].rawURL, "/v1/codex/jobs/job-artifacts/artifacts/artifact-001/raw")
        XCTAssertEqual(job.artifacts[0].previewURL, "/v1/codex/jobs/job-artifacts/artifacts/artifact-001/preview")
    }

    func testCodexClientResolvesArtifactURLsAgainstBaseURL() throws {
        let baseURL = URL(string: "https://codex.pocs.conformal.live")!

        XCTAssertEqual(
            CodexClient.resolvedArtifactURL("/v1/codex/jobs/job/artifacts/artifact-001/raw", baseURL: baseURL),
            URL(string: "https://codex.pocs.conformal.live/v1/codex/jobs/job/artifacts/artifact-001/raw")
        )
        XCTAssertEqual(
            CodexClient.resolvedArtifactURL("https://codex.pocs.conformal.live/v1/codex/jobs/job/artifacts/artifact-001/raw", baseURL: baseURL),
            URL(string: "https://codex.pocs.conformal.live/v1/codex/jobs/job/artifacts/artifact-001/raw")
        )
        XCTAssertNil(CodexClient.resolvedArtifactURL(nil, baseURL: baseURL))
    }

    func testCodexJobDisplayOutputHidesRawCodexTranscript() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-raw",
              "status": "succeeded",
              "prompt": "Check AWS",
              "result": "OpenAI Codex v0.132.0\\nworkdir: /srv/codex-workspaces/scratch\\nexec\\n/bin/bash -lc aws sts get-caller-identity"
            }
            """
        )

        XCTAssertNil(job.displayOutput)
        XCTAssertTrue(job.rawActivityOutput?.contains("OpenAI Codex") == true)
    }

    func testCodexJobDisplayOutputPreviewCapsLargeAnswers() throws {
        let longAnswer = String(repeating: "answer ", count: 10_000)
        let payload = [
            "id": "job-large-answer",
            "status": "succeeded",
            "prompt": "Explain everything",
            "result": longAnswer
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)

        let job = try JSONDecoder().decode(CodexJob.self, from: data)
        let preview = job.displayOutputPreview

        XCTAssertTrue(preview.isTruncated)
        XCTAssertEqual(preview.originalCharacterCount, longAnswer.trimmingCharacters(in: .whitespacesAndNewlines).count)
        XCTAssertLessThan(preview.text.count, longAnswer.count)
        XCTAssertTrue(preview.text.contains("Preview truncated"))
    }

    func testCodexJobRawActivityPreviewDoesNotJoinUnlimitedStreams() throws {
        let hugeStdout = String(repeating: "stdout-line\n", count: 8_000)
        let hugeStderr = String(repeating: "stderr-line\n", count: 8_000)
        let payload = [
            "id": "job-large-activity",
            "status": "failed",
            "prompt": "Run noisy command",
            "stdout": hugeStdout,
            "stderr": hugeStderr,
            "error": "codex exited with code 1"
        ]
        let data = try JSONSerialization.data(withJSONObject: payload)

        let job = try JSONDecoder().decode(CodexJob.self, from: data)
        let preview = job.rawActivityPreview

        XCTAssertTrue(preview.isTruncated)
        XCTAssertGreaterThan(preview.originalCharacterCount, preview.text.count)
        XCTAssertLessThanOrEqual(preview.text.count, CodexDisplayLimits.rawActivityCharacters + 128)
        XCTAssertTrue(preview.text.contains("Showing latest activity"))
        XCTAssertTrue(preview.text.contains("stderr-line"))
        XCTAssertTrue(preview.text.contains("codex exited with code 1"))
    }

    func testCodexJobRawActivityPreviewKeepsLatestLogTail() throws {
        let payload = [
            "id": "job-latest-activity",
            "status": "running",
            "stdout": "old-start\n" + String(repeating: "middle-line\n", count: 900) + "latest-line\n",
            "stderr": "",
            "stdoutTruncated": true
        ] as [String: Any]
        let data = try JSONSerialization.data(withJSONObject: payload)

        let job = try JSONDecoder().decode(CodexJob.self, from: data)
        let preview = job.rawActivityPreview

        XCTAssertTrue(preview.isTruncated)
        XCTAssertFalse(preview.text.contains("old-start"))
        XCTAssertTrue(preview.text.contains("latest-line"))
        XCTAssertTrue(preview.text.contains("Showing latest activity"))
    }

    func testCodexJobDecodesServerOutputTruncationMetadata() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-output-metadata",
              "status": "succeeded",
              "stdout": "short stdout",
              "stderr": "",
              "result": "short answer",
              "stdoutBytes": 120000,
              "stderrBytes": 0,
              "resultBytes": 250000,
              "stdoutTruncated": true,
              "stderrTruncated": false,
              "resultTruncated": true
            }
            """
        )

        XCTAssertEqual(job.stdoutBytes, 120_000)
        XCTAssertEqual(job.resultBytes, 250_000)
        XCTAssertTrue(job.stdoutTruncated)
        XCTAssertTrue(job.resultTruncated)
        XCTAssertTrue(job.hasTruncatedServerOutput)
    }

    func testCodexSessionDecodesServerShape() throws {
        let session = try JSONDecoder().decode(
            CodexSession.self,
            from: Data(
                """
                {
                  "id": "2026-05-20T12-00-00-abc123",
                  "workspaceId": "scratch",
                  "workspaceName": "Scratch",
                  "cwd": "/tmp/codex-scratch",
                  "timestamp": "2026-05-20T12:00:00Z",
                  "updatedAt": "2026-05-20T12:05:10Z"
                }
                """.utf8
            )
        )

        XCTAssertEqual(session.id, "2026-05-20T12-00-00-abc123")
        XCTAssertEqual(session.workspaceId, "scratch")
        XCTAssertEqual(session.workspaceName, "Scratch")
        XCTAssertEqual(session.cwd, "/tmp/codex-scratch")
        XCTAssertNotNil(session.timestamp)
        XCTAssertNotNil(session.updatedAt)
    }

    func testCodexThreadDecodesServerShapeAndBuildsPreviewText() throws {
        let thread = try JSONDecoder().decode(
            CodexThread.self,
            from: Data(
                """
                {
                  "id": "019e46a3-0000-7000-8000-000000000001",
                  "sessionId": "019e46a3-0000-7000-8000-000000000001",
                  "workspaceId": "scratch",
                  "workspaceName": "Scratch",
                  "cwd": "/srv/codex-workspaces/scratch",
                  "timestamp": "2026-05-20T12:00:00Z",
                  "updatedAt": "2026-05-20T12:05:10Z",
                  "jobCount": 2,
                  "activeJobCount": 1,
                  "lastJobId": "019e46a3-0000-7000-8000-000000000003",
                  "lastJobStatus": "running",
                  "lastPrompt": "continue this thread",
                  "lastResult": "thread answer",
                  "lastError": null,
                  "hasSessionFile": true,
                  "isSmokeTest": true
                }
                """.utf8
            )
        )

        XCTAssertEqual(thread.id, "019e46a3-0000-7000-8000-000000000001")
        XCTAssertEqual(thread.workspaceId, "scratch")
        XCTAssertEqual(thread.workspaceName, "Scratch")
        XCTAssertEqual(thread.jobCount, 2)
        XCTAssertEqual(thread.activeJobCount, 1)
        XCTAssertEqual(thread.lastJobId, "019e46a3-0000-7000-8000-000000000003")
        XCTAssertEqual(thread.lastJobStatus, .running)
        XCTAssertEqual(thread.displayTitle, "continue this thread")
        XCTAssertEqual(thread.workspaceLabel, "Scratch")
        XCTAssertEqual(thread.previewText, "continue this thread")
        XCTAssertTrue(thread.hasActiveJobs)
        XCTAssertTrue(thread.hasSessionFile)
        XCTAssertTrue(thread.isSmokeTest)
    }

    func testCodexWorkspaceDirectoryListingDecodesServerShape() throws {
        let listing = try JSONDecoder().decode(
            CodexWorkspaceDirectoryListing.self,
            from: Data(
                """
                {
                  "rootPath": "/Users/parikshit/Desktop",
                  "currentPath": "/Users/parikshit/Desktop/SigiQ",
                  "relativePath": "SigiQ",
                  "parentPath": "/Users/parikshit/Desktop",
                  "selectedWorkspace": {
                    "id": "sigiq",
                    "name": "SigiQ",
                    "path": "/Users/parikshit/Desktop/SigiQ"
                  },
                  "entries": [
                    {
                      "name": "ai-tutor",
                      "path": "/Users/parikshit/Desktop/SigiQ/ai-tutor",
                      "relativePath": "SigiQ/ai-tutor",
                      "workspaceId": "sigiq-ai-tutor",
                      "workspaceName": "AI Tutor",
                      "hasGit": true,
                      "isRegistered": true
                    },
                    {
                      "name": "notes",
                      "path": "/Users/parikshit/Desktop/SigiQ/notes",
                      "relativePath": "SigiQ/notes",
                      "hasGit": false,
                      "isRegistered": false
                    }
                  ]
                }
                """.utf8
            )
        )

        XCTAssertEqual(listing.rootPath, "/Users/parikshit/Desktop")
        XCTAssertEqual(listing.currentPath, "/Users/parikshit/Desktop/SigiQ")
        XCTAssertEqual(listing.relativePath, "SigiQ")
        XCTAssertEqual(listing.parentPath, "/Users/parikshit/Desktop")
        XCTAssertEqual(listing.selectedWorkspace?.id, "sigiq")
        XCTAssertEqual(listing.entries.count, 2)
        XCTAssertEqual(listing.entries[0].id, "/Users/parikshit/Desktop/SigiQ/ai-tutor")
        XCTAssertEqual(listing.entries[0].displayName, "ai-tutor")
        XCTAssertEqual(listing.entries[0].detailText, "AI Tutor")
        XCTAssertTrue(listing.entries[0].hasGit)
        XCTAssertTrue(listing.entries[0].isRegistered)
        XCTAssertEqual(listing.entries[1].detailText, "SigiQ/notes")
        XCTAssertFalse(listing.entries[1].hasGit)
        XCTAssertFalse(listing.entries[1].isRegistered)
    }

    func testCodexWorkspaceDirectoryListingCanNavigateUpFromEmptyParentPath() throws {
        let listing = try JSONDecoder().decode(
            CodexWorkspaceDirectoryListing.self,
            from: Data(
                """
                {
                  "rootPath": "/srv/codex-workspaces",
                  "currentPath": "/srv/codex-workspaces/poc-vault",
                  "relativePath": "poc-vault",
                  "parentPath": "",
                  "entries": []
                }
                """.utf8
            )
        )

        XCTAssertNil(listing.parentPath)
        XCTAssertEqual(listing.upNavigationPath, "/srv/codex-workspaces")
    }

    func testCodexThreadDefaultsMissingProviderToCodexAndDecodesClaude() throws {
        let legacyThread = try decodeCodexThread(
            """
            {
              "id": "thread-legacy",
              "sessionId": "thread-legacy"
            }
            """
        )
        let claudeThread = try decodeCodexThread(
            """
            {
              "id": "thread-claude",
              "sessionId": "thread-claude",
              "provider": "claude"
            }
            """
        )

        XCTAssertEqual(legacyThread.provider, .codex)
        XCTAssertEqual(claudeThread.provider, .claude)
    }

    func testCodexThreadBuildsReadableTitleFromPullRequestURL() throws {
        let thread = try JSONDecoder().decode(
            CodexThread.self,
            from: Data(
                """
                {
                  "id": "019e46a5-0000-7000-8000-000000000001",
                  "sessionId": "019e46a5-0000-7000-8000-000000000001",
                  "workspaceId": "poc-vault",
                  "workspaceName": "POC Vault",
                  "updatedAt": "2026-05-20T12:05:10Z",
                  "jobCount": 0,
                  "activeJobCount": 0,
                  "lastPrompt": "Can you review this PR: https://github.com/example/private-app/pull/967 The idea is to reduce latency",
                  "hasSessionFile": true,
                  "isSmokeTest": false
                }
                """.utf8
            )
        )

        XCTAssertEqual(thread.displayTitle, "private-app PR #967")
        XCTAssertEqual(thread.workspaceLabel, "POC Vault")
        XCTAssertEqual(thread.previewText, "Can you review this PR: https://github.com/example/private-app/pull/967 The idea is to reduce latency")
    }

    func testCodexThreadDetailBuildsChatTranscriptFromMessages() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "019e46a5-0000-7000-8000-000000000001",
                    "sessionId": "019e46a5-0000-7000-8000-000000000001",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:05:10Z",
                    "jobCount": 2,
                    "activeJobCount": 0,
                    "lastPrompt": "latest prompt",
                    "lastResult": "latest answer",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "First thing I asked"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "First Codex answer"
                    },
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:04:00Z",
                      "text": "Second follow up"
                    }
                  ],
                  "jobs": []
                }
                """.utf8
            )
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: detail, thread: nil, latestJob: nil)

        XCTAssertEqual(transcript.map(\.role), [.user, .assistant, .user])
        XCTAssertEqual(transcript.map(\.text), ["First thing I asked", "First Codex answer", "Second follow up"])
        XCTAssertEqual(transcript.first?.alignment, .trailing)
        XCTAssertEqual(transcript[1].alignment, .leading)
        XCTAssertEqual(transcript.first?.isLong, false)
    }

    func testCodexThreadChatTranscriptCollapsesIntermediateAssistantUpdates() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "019e46a5-0000-7000-8000-000000000002",
                    "sessionId": "019e46a5-0000-7000-8000-000000000002",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:05:10Z",
                    "jobCount": 1,
                    "activeJobCount": 0,
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "Check my PRs"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:00:10Z",
                      "text": "I will inspect GitHub."
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:00:20Z",
                      "text": "Retrying with supported fields."
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "Final answer: no assigned PRs."
                    }
                  ],
                  "jobs": []
                }
                """.utf8
            )
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: detail, thread: nil, latestJob: nil)

        XCTAssertEqual(transcript.map(\.role), [.user, .status, .assistant])
        XCTAssertEqual(transcript[1].speakerLabel, "Thinking")
        XCTAssertEqual(transcript[1].progressCount, 2)
        XCTAssertEqual(transcript[2].text, "Final answer: no assigned PRs.")
    }

    func testCodexThreadChatTranscriptFallsBackToThreadSummary() throws {
        let thread = try JSONDecoder().decode(
            CodexThread.self,
            from: Data(
                """
                {
                  "id": "019e46a5-0000-7000-8000-000000000001",
                  "sessionId": "019e46a5-0000-7000-8000-000000000001",
                  "workspaceId": "poc-vault",
                  "workspaceName": "POC Vault",
                  "updatedAt": "2026-05-20T12:05:10Z",
                  "jobCount": 1,
                  "activeJobCount": 0,
                  "lastJobStatus": "succeeded",
                  "lastPrompt": "Can you check the server?",
                  "lastResult": "Server is healthy.",
                  "hasSessionFile": false
                }
                """.utf8
            )
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: thread, latestJob: nil)

        XCTAssertEqual(transcript.map(\.role), [.user, .assistant])
        XCTAssertEqual(transcript.map(\.text), ["Can you check the server?", "Server is healthy."])
    }

    func testCodexThreadChatTranscriptMarksThreadSummaryAsFullTextLoadable() throws {
        let thread = try JSONDecoder().decode(
            CodexThread.self,
            from: Data(
                """
                {
                  "id": "019e46a5-0000-7000-8000-000000000011",
                  "sessionId": "019e46a5-0000-7000-8000-000000000011",
                  "workspaceId": "poc-vault",
                  "workspaceName": "POC Vault",
                  "updatedAt": "2026-05-20T12:05:10Z",
                  "jobCount": 1,
                  "activeJobCount": 0,
                  "lastJobId": "job-summary-preview",
                  "lastJobStatus": "succeeded",
                  "lastPrompt": "Summarize this folder.",
                  "lastResult": "This is the saved thread summary.",
                  "hasSessionFile": true
                }
                """.utf8
            )
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: thread, latestJob: nil)

        let answer = try XCTUnwrap(transcript.first { $0.role == .assistant })
        XCTAssertTrue(answer.canLoadFullText)
        XCTAssertTrue(answer.isLong)
    }

    func testCodexThreadChatTranscriptMarksServerTruncatedJobAnswerAsFullTextLoadable() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "019e46a5-0000-7000-8000-000000000012",
              "sessionId": "019e46a5-0000-7000-8000-000000000012",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-20T12:05:10Z",
              "jobCount": 1,
              "activeJobCount": 0,
              "lastJobId": "job-truncated-answer",
              "lastJobStatus": "succeeded",
              "lastPrompt": "List assigned PRs",
              "hasSessionFile": true
            }
            """
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-truncated-answer",
              "provider": "codex",
              "status": "succeeded",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "List assigned PRs",
              "result": "I found one assigned PR and this preview is not the full final answer.",
              "resultTruncated": true,
              "logsIncluded": "compact",
              "completedAt": "2026-05-20T12:05:10Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: thread, latestJob: job)

        let answer = try XCTUnwrap(transcript.first { $0.role == .assistant })
        XCTAssertEqual(answer.text, "I found one assigned PR and this preview is not the full final answer.")
        XCTAssertTrue(answer.canLoadFullText)
        XCTAssertTrue(answer.isLong)
    }

    func testCodexThreadChatTranscriptShowsEmptySuccessfulClaudeJobAsIssue() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "3210752c-bec9-41ad-a989-afe8380585f1",
              "sessionId": "3210752c-bec9-41ad-a989-afe8380585f1",
              "provider": "claude",
              "workspaceId": "dir-yuno-claude-code",
              "workspaceName": "yuno claude code",
              "updatedAt": "2026-05-25T01:41:14Z",
              "jobCount": 1,
              "activeJobCount": 0,
              "lastJobId": "1db799ed-2377-4b17-b47e-f84d3824f218",
              "lastJobStatus": "succeeded",
              "lastPrompt": "Get this done. Write me a plan first.",
              "hasSessionFile": true
            }
            """
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "1db799ed-2377-4b17-b47e-f84d3824f218",
              "provider": "claude",
              "status": "succeeded",
              "workspaceId": "dir-yuno-claude-code",
              "workspaceName": "yuno claude code",
              "prompt": "Get this done. Write me a plan first.",
              "stdout": "\\n",
              "result": "",
              "completedAt": "2026-05-25T01:41:14Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: thread, latestJob: job)

        XCTAssertEqual(transcript.map(\.role), [.user, .status])
        XCTAssertEqual(transcript.map(\.text), [
            "Get this done. Write me a plan first.",
            "Claude finished without producing output."
        ])
        XCTAssertTrue(try XCTUnwrap(transcript.last).isError)
    }

    func testCodexThreadChatTranscriptUsesFullLatestJobAnswerOverThreadPreview() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "thread-preview-answer",
                    "sessionId": "thread-preview-answer",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:05:10Z",
                    "jobCount": 1,
                    "activeJobCount": 0,
                    "lastJobId": "job-full-answer",
                    "lastJobStatus": "succeeded",
                    "lastPrompt": "List assigned issues",
                    "lastResult": "Short answer preview...",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "List assigned issues"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "Short answer preview..."
                    }
                  ],
                  "jobs": []
                }
                """.utf8
            )
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-full-answer",
              "provider": "codex",
              "status": "succeeded",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "List assigned issues",
              "result": "Full answer line one.\\n\\n- ENGG-541: action item one.\\n- ENGG-542: action item two.\\n- ENGG-543: action item three.",
              "resultTruncated": false,
              "logsIncluded": "compact",
              "completedAt": "2026-05-20T12:05:10Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: detail, thread: nil, latestJob: job)

        let answer = try XCTUnwrap(transcript.last { $0.role == .assistant })
        XCTAssertEqual(answer.text, "Full answer line one.\n\n- ENGG-541: action item one.\n- ENGG-542: action item two.\n- ENGG-543: action item three.")
        XCTAssertFalse(answer.canLoadFullText)
    }

    func testCodexThreadChatTranscriptAppendsCompletedFollowUpToStaleDetail() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "thread-stale-follow-up",
                    "sessionId": "thread-stale-follow-up",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:01:00Z",
                    "jobCount": 1,
                    "activeJobCount": 0,
                    "lastJobId": "job-first",
                    "lastJobStatus": "succeeded",
                    "lastPrompt": "What can be done here?",
                    "lastResult": "Here is what you can do.",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "What can be done here?"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "Here is what you can do."
                    }
                  ],
                  "jobs": []
                }
                """.utf8
            )
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-follow-up",
              "provider": "codex",
              "status": "succeeded",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "Anything else?",
              "result": "Yes. You can also inspect server health.",
              "resultTruncated": false,
              "logsIncluded": "compact",
              "createdAt": "2026-05-20T12:05:00Z",
              "completedAt": "2026-05-20T12:06:00Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: detail, thread: nil, latestJob: job)

        XCTAssertEqual(transcript.map(\.role), [.user, .assistant, .user, .assistant])
        XCTAssertEqual(
            transcript.map(\.text),
            [
                "What can be done here?",
                "Here is what you can do.",
                "Anything else?",
                "Yes. You can also inspect server health."
            ]
        )
    }

    func testCodexThreadChatTranscriptShowsWorkingPlaceholderForRunningFollowUp() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "019e46a5-0000-7000-8000-000000000004",
              "sessionId": "019e46a5-0000-7000-8000-000000000004",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-20T12:05:10Z",
              "jobCount": 2,
              "activeJobCount": 0,
              "lastJobStatus": "succeeded",
              "lastPrompt": "Review",
              "hasSessionFile": true
            }
            """
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-running-follow-up",
              "provider": "codex",
              "status": "running",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "Review",
              "createdAt": "2026-05-20T12:05:12Z",
              "startedAt": "2026-05-20T12:05:13Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: thread, latestJob: job)

        XCTAssertEqual(transcript.map(\.role), [.user, .status])
        XCTAssertEqual(transcript.map(\.sourceID), ["thread-prompt", "thread-working"])
        let workingItem = try XCTUnwrap(transcript.last)
        XCTAssertEqual(workingItem.text, "Codex is working.")
        XCTAssertEqual(workingItem.alignment, .leading)
    }

    func testCodexThreadChatTranscriptShowsPendingFollowUpBeforeJobHydrates() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "thread-pending-follow-up",
                    "sessionId": "thread-pending-follow-up",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:01:00Z",
                    "jobCount": 1,
                    "activeJobCount": 0,
                    "lastJobId": "job-first",
                    "lastJobStatus": "succeeded",
                    "lastPrompt": "What can be done here?",
                    "lastResult": "Here is what you can do.",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "What can be done here?"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "Here is what you can do."
                    }
                  ],
                  "jobs": []
                }
                """.utf8
            )
        )
        let pending = CodexPendingFollowUp(
            jobID: "job-pending-follow-up",
            prompt: "Please check the remaining edge cases.",
            provider: .codex,
            createdAt: Date(timeIntervalSince1970: 1_779_278_712)
        )

        let transcript = CodexThreadChatItem.makeTranscript(
            detail: detail,
            thread: nil,
            latestJob: nil,
            pendingFollowUp: pending
        )

        XCTAssertEqual(transcript.map(\.role), [.user, .assistant, .user, .status])
        XCTAssertEqual(
            transcript.map(\.text),
            [
                "What can be done here?",
                "Here is what you can do.",
                "Please check the remaining edge cases.",
                "Codex is working."
            ]
        )
        XCTAssertEqual(transcript.map(\.sourceID).suffix(2), ["pending-follow-up-job-pending-follow-up", "thread-working"])
    }

    func testCodexThreadChatTranscriptKeepsPendingPromptWhenHydratedJobPromptHasSkillWrapper() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "thread-pending-skill",
              "sessionId": "thread-pending-skill",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-20T12:05:10Z",
              "jobCount": 2,
              "activeJobCount": 0,
              "lastJobStatus": "succeeded",
              "lastPrompt": "Previous prompt",
              "lastResult": "Previous answer",
              "hasSessionFile": true
            }
            """
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-pending-skill",
              "provider": "codex",
              "status": "running",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "Use these Codex skills for this task: human-code-review.\\n\\nPlease check the remaining edge cases.",
              "createdAt": "2026-05-20T12:05:12Z",
              "startedAt": "2026-05-20T12:05:13Z"
            }
            """
        )
        let pending = CodexPendingFollowUp(
            jobID: "job-pending-skill",
            prompt: "Please check the remaining edge cases.",
            provider: .codex,
            createdAt: Date(timeIntervalSince1970: 1_779_278_712)
        )

        let transcript = CodexThreadChatItem.makeTranscript(
            detail: nil,
            thread: thread,
            latestJob: job,
            pendingFollowUp: pending
        )

        XCTAssertEqual(transcript.map(\.role), [.user, .status])
        XCTAssertEqual(transcript.first?.text, "Please check the remaining edge cases.")
        XCTAssertFalse(transcript.contains { $0.text.contains("Use these Codex skills") })
    }

    func testCodexThreadChatTranscriptShowsRepeatedPendingFollowUpTextAsNewTurn() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "thread-repeated-follow-up",
                    "sessionId": "thread-repeated-follow-up",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:01:00Z",
                    "jobCount": 1,
                    "activeJobCount": 0,
                    "lastJobId": "job-first",
                    "lastJobStatus": "succeeded",
                    "lastPrompt": "Continue",
                    "lastResult": "Here is the first continuation.",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "Continue"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "Here is the first continuation."
                    }
                  ],
                  "jobs": []
                }
                """.utf8
            )
        )
        let pending = CodexPendingFollowUp(
            jobID: "job-repeated-follow-up",
            prompt: "Continue",
            provider: .codex,
            createdAt: Date(timeIntervalSince1970: 1_779_278_712)
        )

        let transcript = CodexThreadChatItem.makeTranscript(
            detail: detail,
            thread: nil,
            latestJob: nil,
            pendingFollowUp: pending
        )

        XCTAssertEqual(transcript.filter { $0.role == .user && $0.text == "Continue" }.count, 2)
        XCTAssertEqual(transcript.map(\.sourceID).suffix(2), ["pending-follow-up-job-repeated-follow-up", "thread-working"])
    }

    func testCodexThreadChatTranscriptKeepsWorkingPlaceholderWithProgressUpdates() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "thread-progress-running",
                    "sessionId": "thread-progress-running",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:06:00Z",
                    "jobCount": 1,
                    "activeJobCount": 1,
                    "lastJobId": "job-running-progress",
                    "lastJobStatus": "running",
                    "lastPrompt": "List issues",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "List issues"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:00:10Z",
                      "text": "I am pulling Linear issues."
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:00:20Z",
                      "text": "I am reading issue details."
                    }
                  ],
                  "jobs": [
                    {
                      "id": "job-running-progress",
                      "provider": "codex",
                      "status": "running",
                      "workspaceId": "poc-vault",
                      "workspaceName": "POC Vault",
                      "prompt": "List issues",
                      "createdAt": "2026-05-20T12:00:00Z",
                      "startedAt": "2026-05-20T12:00:02Z"
                    }
                  ]
                }
                """.utf8
            )
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: detail, thread: nil, latestJob: detail.jobs.first)

        XCTAssertEqual(transcript.map(\.kind), [.message, .progressSummary, .workingPlaceholder])
        XCTAssertEqual(transcript.last?.text, "Codex is working.")
    }

    func testCodexThreadChatTranscriptShowsPendingFirstRunLikeThreadChat() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-starting-thread",
              "provider": "codex",
              "status": "running",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "Build a deployment checklist",
              "createdAt": "2026-05-20T12:05:12Z",
              "startedAt": "2026-05-20T12:05:13Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: nil, latestJob: job)

        XCTAssertEqual(transcript.map(\.role), [.user, .status])
        XCTAssertEqual(transcript.first?.text, "Build a deployment checklist")
        XCTAssertEqual(transcript.first?.alignment, .trailing)
        XCTAssertEqual(transcript.last?.kind, .workingPlaceholder)
        XCTAssertEqual(transcript.last?.text, "Codex is working.")
    }

    func testCodexThreadChatTranscriptDoesNotPairRunningFollowUpWithStaleThreadAnswer() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "019e46a5-0000-7000-8000-000000000006",
              "sessionId": "019e46a5-0000-7000-8000-000000000006",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-20T12:05:10Z",
              "jobCount": 2,
              "activeJobCount": 0,
              "lastJobStatus": "succeeded",
              "lastPrompt": "Are there any PRs assigned to me?",
              "lastResult": "One PR is assigned to you.",
              "hasSessionFile": true
            }
            """
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-running-review",
              "provider": "codex",
              "status": "running",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "Review",
              "createdAt": "2026-05-20T12:06:12Z",
              "startedAt": "2026-05-20T12:06:13Z"
            }
            """
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: nil, thread: thread, latestJob: job)

        XCTAssertEqual(transcript.map(\.role), [.user, .status])
        XCTAssertEqual(transcript.map(\.text), ["Review", "Codex is working."])
    }

    func testCodexThreadChatTranscriptCollapsesTrailingAssistantUpdateWhileFollowUpRuns() throws {
        let detail = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "019e46a5-0000-7000-8000-000000000005",
                    "sessionId": "019e46a5-0000-7000-8000-000000000005",
                    "workspaceId": "poc-vault",
                    "workspaceName": "POC Vault",
                    "updatedAt": "2026-05-20T12:06:00Z",
                    "jobCount": 2,
                    "activeJobCount": 1,
                    "lastJobStatus": "running",
                    "lastPrompt": "Review",
                    "hasSessionFile": true
                  },
                  "messages": [
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:00:00Z",
                      "text": "Are there any PRs assigned to me?"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:01:00Z",
                      "text": "One PR is assigned to you."
                    },
                    {
                      "role": "user",
                      "timestamp": "2026-05-20T12:05:12Z",
                      "text": "Review"
                    },
                    {
                      "role": "assistant",
                      "timestamp": "2026-05-20T12:05:20Z",
                      "text": "I'll inspect the review target."
                    }
                  ],
                  "jobs": [
                    {
                      "id": "job-running-follow-up",
                      "provider": "codex",
                      "status": "running",
                      "workspaceId": "poc-vault",
                      "workspaceName": "POC Vault",
                      "prompt": "Review",
                      "createdAt": "2026-05-20T12:05:12Z",
                      "startedAt": "2026-05-20T12:05:13Z"
                    }
                  ]
                }
                """.utf8
            )
        )

        let transcript = CodexThreadChatItem.makeTranscript(detail: detail, thread: nil, latestJob: detail.jobs.first)

        XCTAssertEqual(transcript.map(\.role), [.user, .assistant, .user, .status, .status])
        XCTAssertEqual(transcript[3].kind, .progressSummary)
        XCTAssertEqual(transcript[3].progressCount, 1)
        XCTAssertEqual(transcript[4].kind, .workingPlaceholder)
        XCTAssertFalse(transcript.contains { $0.role == .assistant && $0.text == "I'll inspect the review target." })
    }

    func testCodexThreadDetailRefreshPolicyPollsWhileThreadOrFollowUpIsActive() throws {
        let idleThread = try decodeCodexThread(
            """
            {
              "id": "thread-idle",
              "sessionId": "thread-idle",
              "workspaceName": "POC Vault",
              "activeJobCount": 0,
              "lastJobStatus": "succeeded"
            }
            """
        )
        let activeThread = try decodeCodexThread(
            """
            {
              "id": "thread-active",
              "sessionId": "thread-active",
              "workspaceName": "POC Vault",
              "activeJobCount": 1,
              "lastJobStatus": "running"
            }
            """
        )
        let runningJob = try decodeCodexJob(
            """
            {
              "id": "job-running",
              "status": "running",
              "workspaceName": "POC Vault"
            }
            """
        )

        XCTAssertTrue(CodexThreadDetailRefreshPolicy.shouldPoll(thread: activeThread, latestJob: nil, pendingFollowUpJobID: nil))
        XCTAssertTrue(CodexThreadDetailRefreshPolicy.shouldPoll(thread: idleThread, latestJob: runningJob, pendingFollowUpJobID: nil))
        XCTAssertTrue(CodexThreadDetailRefreshPolicy.shouldPoll(thread: idleThread, latestJob: nil, pendingFollowUpJobID: "job-running"))
        XCTAssertFalse(CodexThreadDetailRefreshPolicy.shouldPoll(thread: idleThread, latestJob: nil, pendingFollowUpJobID: nil))
    }

    func testCodexThreadFeedUsesThreadsInsteadOfDuplicateJobs() throws {
        let thread = try JSONDecoder().decode(
            CodexThread.self,
            from: Data(
                """
                {
                  "id": "019e4970-7d46-7513-bc45-5a2d4c672cca",
                  "sessionId": "019e4970-7d46-7513-bc45-5a2d4c672cca",
                  "workspaceId": "poc-vault",
                  "workspaceName": "POC Vault",
                  "updatedAt": "2026-05-21T07:35:00Z",
                  "lastJobId": "job-thread",
                  "lastJobStatus": "succeeded",
                  "lastPrompt": "Give him a strong feedback on slack too",
                  "lastResult": "Sent the Slack DM.",
                  "jobCount": 1,
                  "hasSessionFile": true
                }
                """.utf8
            )
        )
        let job = try decodeCodexJob(
            """
            {
              "id": "job-thread",
              "status": "succeeded",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "prompt": "Give him a strong feedback on slack too",
              "result": "Sent the Slack DM.",
              "sessionId": "019e4970-7d46-7513-bc45-5a2d4c672cca",
              "updatedAt": "2026-05-21T07:35:00Z"
            }
            """
        )

        let feed = CodexThreadFeedItem.makeFeed(threads: [thread], jobs: [job])

        XCTAssertEqual(feed.count, 1)
        XCTAssertEqual(feed.first?.sessionID, thread.sessionId)
        XCTAssertEqual(feed.first?.jobID, "job-thread")
        XCTAssertFalse(feed.first?.isPendingSession ?? true)
        XCTAssertEqual(feed.first?.preview, "Sent the Slack DM.")
    }

    func testCodexThreadFeedShowsActiveAndFailedJobsWaitingForSessionDiscovery() throws {
        let activeJob = try decodeCodexJob(
            """
            {
              "id": "job-starting",
              "status": "running",
              "workspaceId": "scratch",
              "workspaceName": "Scratch",
              "prompt": "Check deployment health",
              "updatedAt": "2026-05-21T07:40:00Z"
            }
            """
        )
        let oldOrphanJob = try decodeCodexJob(
            """
            {
              "id": "job-old-orphan",
              "status": "failed",
              "workspaceId": "scratch",
              "workspaceName": "Scratch",
              "prompt": "Bad request",
              "error": "No session",
              "updatedAt": "2026-05-21T07:30:00Z"
            }
            """
        )

        let feed = CodexThreadFeedItem.makeFeed(threads: [], jobs: [oldOrphanJob, activeJob])

        XCTAssertEqual(feed.count, 2)
        XCTAssertEqual(feed.first?.jobID, "job-starting")
        XCTAssertTrue(feed.first?.isPendingSession == true)
        XCTAssertEqual(feed.first?.title, "Check deployment health")
        XCTAssertTrue(feed.first?.preview.contains("Starting on EC2") == true)
        XCTAssertEqual(feed.last?.jobID, "job-old-orphan")
        XCTAssertEqual(feed.last?.preview, "No session")
    }

    func testCodexThreadFeedPreviewStripsMarkdownFormatting() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "thread-markdown-preview",
              "sessionId": "thread-markdown-preview",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-21T07:35:00Z",
              "lastJobId": "job-markdown-preview",
              "lastJobStatus": "succeeded",
              "lastPrompt": "Explain this project.",
              "lastResult": "## POC Vault\\n\\nThis is a **private iOS POC vault** for hosting AI-generated frontend prototypes.\\n\\n- **Backend:** EC2 VM running nginx\\n- POCs: Static files in `pocs/<slug>/public/`",
              "jobCount": 1,
              "hasSessionFile": true
            }
            """
        )

        let feed = CodexThreadFeedItem.makeFeed(threads: [thread], jobs: [])
        let preview = try XCTUnwrap(feed.first?.preview)

        XCTAssertEqual(
            preview,
            "POC Vault This is a private iOS POC vault for hosting AI-generated frontend prototypes. Backend: EC2 VM running nginx POCs: Static files in pocs/<slug>/public/"
        )
        XCTAssertFalse(preview.contains("##"))
        XCTAssertFalse(preview.contains("**"))
        XCTAssertFalse(preview.contains("`"))
    }

    func testCodexThreadFeedCanBeScopedToSelectedWorkspace() throws {
        let pocThread = try decodeCodexThread(
            """
            {
              "id": "thread-poc",
              "sessionId": "thread-poc",
              "workspaceId": "poc-vault",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-21T07:35:00Z",
              "lastJobId": "job-poc",
              "lastJobStatus": "succeeded",
              "lastPrompt": "Work on Relay",
              "lastResult": "Relay is updated."
            }
            """
        )
        let sigiqThread = try decodeCodexThread(
            """
            {
              "id": "thread-sigiq",
              "sessionId": "thread-sigiq",
              "workspaceId": "sigiq",
              "workspaceName": "SigiQ",
              "updatedAt": "2026-05-21T07:40:00Z",
              "lastJobId": "job-sigiq",
              "lastJobStatus": "running",
              "lastPrompt": "Work on SigiQ",
              "activeJobCount": 1
            }
            """
        )
        let sigiqJob = try decodeCodexJob(
            """
            {
              "id": "job-sigiq-pending",
              "status": "running",
              "workspaceId": "sigiq",
              "workspaceName": "SigiQ",
              "prompt": "Still running in SigiQ",
              "updatedAt": "2026-05-21T07:42:00Z"
            }
            """
        )

        let feed = CodexThreadFeedItem.makeFeed(
            threads: [pocThread, sigiqThread],
            jobs: [sigiqJob],
            workspaceID: "poc-vault"
        )

        XCTAssertEqual(feed.compactMap(\.workspaceID), ["poc-vault"])
        XCTAssertEqual(feed.compactMap(\.sessionID), ["thread-poc"])
    }

    func testCodexComposeStatusUsesSelectedOrActiveThreadUpdate() throws {
        let selectedThread = try decodeCodexThread(
            """
            {
              "id": "thread-selected",
              "sessionId": "thread-selected",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-21T07:30:00Z",
              "lastJobId": "job-selected",
              "lastJobStatus": "succeeded",
              "lastPrompt": "Review the latest patch",
              "lastResult": "The review is complete.",
              "activeJobCount": 0
            }
            """
        )
        let activeThread = try decodeCodexThread(
            """
            {
              "id": "thread-active",
              "sessionId": "thread-active",
              "workspaceName": "POC Vault",
              "updatedAt": "2026-05-21T07:40:00Z",
              "lastJobId": "job-active",
              "lastJobStatus": "running",
              "lastPrompt": "Deploy the Relay build",
              "lastResult": "The machine is building the app.",
              "activeJobCount": 1
            }
            """
        )

        let activeStatus = CodexThreadFeedItem.composeStatusItem(
            selectedSessionID: nil,
            threads: [selectedThread, activeThread],
            jobs: []
        )
        let selectedStatus = CodexThreadFeedItem.composeStatusItem(
            selectedSessionID: "thread-selected",
            threads: [selectedThread, activeThread],
            jobs: []
        )

        XCTAssertEqual(activeStatus?.sessionID, "thread-active")
        XCTAssertEqual(activeStatus?.preview, "The machine is building the app.")
        XCTAssertEqual(selectedStatus?.sessionID, "thread-selected")
        XCTAssertEqual(selectedStatus?.preview, "The review is complete.")
    }

    func testCodexJobDecodesResumeSessionID() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-3",
              "workspaceId": "scratch",
              "status": "succeeded",
              "resumeSessionId": "2026-05-20T12-00-00-abc123"
            }
            """
        )

        XCTAssertEqual(job.resumeSessionId, "2026-05-20T12-00-00-abc123")
        XCTAssertEqual(job.threadSessionId, "2026-05-20T12-00-00-abc123")
    }

    func testCodexJobDecodesFreshSessionIDForFollowUp() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-4",
              "workspaceId": "scratch",
              "status": "succeeded",
              "sessionId": "2026-05-21T12-00-00-thread123",
              "logsIncluded": "preview"
            }
            """
        )

        XCTAssertEqual(job.sessionId, "2026-05-21T12-00-00-thread123")
        XCTAssertEqual(job.threadSessionId, "2026-05-21T12-00-00-thread123")
        XCTAssertEqual(job.logsIncluded, "preview")
    }

    func testCodexCreateJobRequestEncodesResumeSessionID() throws {
        let request = CodexCreateJobRequest(
            workspaceId: "scratch",
            prompt: "continue carefully",
            timeoutMs: 120_000,
            model: "gpt-5.5",
            reasoningEffort: "xhigh",
            resumeSessionId: "2026-05-20T12-00-00-abc123"
        )

        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]

        XCTAssertEqual(payload?["workspaceId"] as? String, "scratch")
        XCTAssertEqual(payload?["prompt"] as? String, "continue carefully")
        XCTAssertEqual(payload?["timeoutMs"] as? Int, 120_000)
        XCTAssertEqual(payload?["model"] as? String, "gpt-5.5")
        XCTAssertEqual(payload?["reasoningEffort"] as? String, "xhigh")
        XCTAssertEqual(payload?["resumeSessionId"] as? String, "2026-05-20T12-00-00-abc123")
    }

    func testCodexCreateJobRequestEncodesProvider() throws {
        let request = CodexCreateJobRequest(
            workspaceId: "scratch",
            prompt: "continue carefully",
            timeoutMs: 120_000,
            model: "sonnet",
            reasoningEffort: "high",
            provider: .claude,
            resumeSessionId: "thread-123"
        )

        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]

        XCTAssertEqual(payload?["provider"] as? String, "claude")
    }

    func testCodexCreateJobRequestEncodesAttachments() throws {
        let attachment = CodexJobAttachment(
            filename: "capture.png",
            contentType: "image/png",
            data: Data("phone-image".utf8)
        )
        let request = CodexCreateJobRequest(
            workspaceId: "poc-vault",
            prompt: "Look at the screenshot",
            timeoutMs: 180_000,
            model: "gpt-5.5",
            reasoningEffort: "low",
            attachments: [attachment],
            resumeSessionId: "2026-05-20T12-00-00-abc123"
        )

        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]
        let attachments = payload?["attachments"] as? [[String: Any]]

        XCTAssertEqual(attachments?.count, 1)
        XCTAssertEqual(attachments?.first?["filename"] as? String, "capture.png")
        XCTAssertEqual(attachments?.first?["contentType"] as? String, "image/png")
        XCTAssertEqual(attachments?.first?["dataBase64"] as? String, Data("phone-image".utf8).base64EncodedString())
    }

    func testCodexViewModelTreatsSwiftCancellationAsNonError() throws {
        XCTAssertTrue(CodexConsoleViewModel.isCancellation(CancellationError()))
    }

    @MainActor
    func testCodexViewModelUsesProviderSpecificDefaults() throws {
        let codexViewModel = CodexConsoleViewModel(
            client: CodexClient(
                baseURL: URL(string: "https://codex.example.test")!,
                identityStore: ClientIdentityStore()
            )
        )
        let claudeViewModel = CodexConsoleViewModel(
            client: CodexClient(
                baseURL: URL(string: "https://codex.example.test")!,
                identityStore: ClientIdentityStore()
            ),
            provider: .claude
        )

        XCTAssertEqual(codexViewModel.provider, .codex)
        XCTAssertEqual(codexViewModel.selectedModel, "gpt-5.5")
        XCTAssertEqual(codexViewModel.selectedReasoningEffort, .xhigh)
        XCTAssertEqual(claudeViewModel.provider, .claude)
        XCTAssertEqual(claudeViewModel.selectedModel, "sonnet")
        XCTAssertEqual(claudeViewModel.selectedReasoningEffort, .high)
        XCTAssertEqual(claudeViewModel.connectionNoticeTitle, "Claude needs certificate")
    }

    func testCodexViewModelTreatsURLSessionCancellationAsNonError() throws {
        XCTAssertTrue(CodexConsoleViewModel.isCancellation(URLError(.cancelled)))
        XCTAssertFalse(CodexConsoleViewModel.isCancellation(URLError(.notConnectedToInternet)))
    }

    func testCodexViewModelClassifiesMissingJobAsNotFound() throws {
        XCTAssertTrue(CodexConsoleViewModel.isHTTPNotFound(CodexClientError.httpFailure(404, "job not found")))
        XCTAssertFalse(CodexConsoleViewModel.isHTTPNotFound(CodexClientError.httpFailure(500, "server failed")))
    }

    func testCodexViewModelClassifiesTransientConnectionFailures() throws {
        XCTAssertTrue(CodexConsoleViewModel.isTransientConnection(URLError(.networkConnectionLost)))
        XCTAssertTrue(CodexConsoleViewModel.isTransientConnection(URLError(.timedOut)))
        XCTAssertFalse(CodexConsoleViewModel.isTransientConnection(CodexClientError.httpFailure(404, "job not found")))
    }

    func testCodexCompletionSignalDetectsObservedJobCompletion() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-42",
              "workspaceName": "POC Vault",
              "status": "succeeded",
              "prompt": "Deploy the gallery POC",
              "result": "Done.",
              "sessionId": "thread-42"
            }
            """
        )

        let signals = CodexCompletionSignal.completedJobs(
            previouslyActiveJobIDs: ["job-42"],
            jobs: [job],
            notifiedKeys: []
        )

        XCTAssertEqual(signals.count, 1)
        XCTAssertEqual(signals.first?.key, "job:job-42")
        XCTAssertEqual(signals.first?.title, "Codex finished")
        XCTAssertEqual(signals.first?.body, "Your Codex thread is ready: Deploy the gallery POC")
        XCTAssertEqual(signals.first?.jobID, "job-42")
        XCTAssertEqual(signals.first?.sessionID, "thread-42")
    }

    func testCodexCompletionSignalWaitsForSucceededJobOutput() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-45",
              "workspaceName": "POC Vault",
              "status": "succeeded",
              "prompt": "Run a report",
              "sessionId": "thread-45"
            }
            """
        )

        let signals = CodexCompletionSignal.completedJobs(
            previouslyActiveJobIDs: ["job-45"],
            jobs: [job],
            notifiedKeys: []
        )

        XCTAssertTrue(signals.isEmpty)
    }

    func testCodexCompletionSignalIgnoresCompletedJobsThatWereNotObservedActive() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-43",
              "workspaceName": "POC Vault",
              "status": "succeeded",
              "prompt": "Old finished run"
            }
            """
        )

        let signals = CodexCompletionSignal.completedJobs(
            previouslyActiveJobIDs: [],
            jobs: [job],
            notifiedKeys: []
        )

        XCTAssertTrue(signals.isEmpty)
    }

    func testCodexCompletionSignalFallsBackToThreadCompletion() throws {
        let thread = try decodeCodexThread(
            """
            {
              "id": "thread-44",
              "sessionId": "thread-44",
              "workspaceName": "POC Vault",
              "activeJobCount": 0,
              "lastJobId": "job-44",
              "lastJobStatus": "failed",
              "lastPrompt": "Run the smoke check"
            }
            """
        )

        let signals = CodexCompletionSignal.completedThreads(
            previouslyActiveThreadIDs: ["thread-44"],
            threads: [thread],
            notifiedKeys: []
        )

        XCTAssertEqual(signals.count, 1)
        XCTAssertEqual(signals.first?.key, "job:job-44")
        XCTAssertEqual(signals.first?.title, "Codex needs attention")
        XCTAssertEqual(signals.first?.body, "Codex hit an error: Run the smoke check")
        XCTAssertEqual(signals.first?.jobID, "job-44")
        XCTAssertEqual(signals.first?.sessionID, "thread-44")
    }

    func testCodexAgentMonitorPolicyContinuesPollingObservedActiveWork() throws {
        XCTAssertTrue(CodexAgentMonitorPolicy.shouldRefresh(hasActiveJobs: true, observedActiveJobCount: 0, observedActiveThreadCount: 0))
        XCTAssertTrue(CodexAgentMonitorPolicy.shouldRefresh(hasActiveJobs: false, observedActiveJobCount: 1, observedActiveThreadCount: 0))
        XCTAssertTrue(CodexAgentMonitorPolicy.shouldRefresh(hasActiveJobs: false, observedActiveJobCount: 0, observedActiveThreadCount: 1))
        XCTAssertFalse(CodexAgentMonitorPolicy.shouldRefresh(hasActiveJobs: false, observedActiveJobCount: 0, observedActiveThreadCount: 0))
    }

    func testCodexAgentMonitorPolicySkipsAppMonitorDuringUnitTests() throws {
        XCTAssertFalse(CodexAgentMonitorPolicy.shouldStartAppMonitor(isRunningTests: true))
        XCTAssertTrue(CodexAgentMonitorPolicy.shouldStartAppMonitor(isRunningTests: false))
    }

    @MainActor
    func testCodexViewModelAppendsTranscriptionToExistingPrompt() throws {
        let viewModel = CodexConsoleViewModel(
            client: CodexClient(
                baseURL: URL(string: "https://codex.example.test")!,
                identityStore: ClientIdentityStore()
            )
        )

        viewModel.prompt = "Run the smoke test."
        viewModel.appendTranscription("Then deploy it.")

        XCTAssertEqual(viewModel.prompt, "Run the smoke test.\n\nThen deploy it.")
    }

    @MainActor
    func testCodexViewModelUsesTranscriptionAsPromptWhenPromptIsEmpty() throws {
        let viewModel = CodexConsoleViewModel(
            client: CodexClient(
                baseURL: URL(string: "https://codex.example.test")!,
                identityStore: ClientIdentityStore()
            )
        )

        viewModel.appendTranscription("Check the live Codex health.")

        XCTAssertEqual(viewModel.prompt, "Check the live Codex health.")
    }

    func testCodexPromptAudioRecordingConfigurationUsesPlainRecordSession() {
        let configuration = CodexPromptAudioRecordingConfiguration.devicePromptDefaults

        XCTAssertEqual(configuration.category, .record)
        XCTAssertEqual(configuration.mode, .default)
        XCTAssertTrue(configuration.options.isEmpty)
        XCTAssertEqual(configuration.settings[AVFormatIDKey] as? AudioFormatID, kAudioFormatLinearPCM)
        XCTAssertEqual(configuration.settings[AVSampleRateKey] as? Double, 16_000)
        XCTAssertEqual(configuration.settings[AVNumberOfChannelsKey] as? Int, 1)
        XCTAssertEqual(configuration.settings[AVLinearPCMBitDepthKey] as? Int, 16)
        XCTAssertEqual(configuration.settings[AVLinearPCMIsBigEndianKey] as? Bool, false)
        XCTAssertEqual(configuration.settings[AVLinearPCMIsFloatKey] as? Bool, false)
        XCTAssertEqual(configuration.settings[AVLinearPCMIsNonInterleaved] as? Bool, false)
    }

    func testClientIdentityStoreResolvesSetupLaunchPassphrase() throws {
        let passphrase = ClientIdentityStore.resolvedImportPassphrase(
            explicitPassphrase: "",
            environment: ["POC_VAULT_P12_PASSPHRASE": " device-secret \n"]
        )

        XCTAssertEqual(passphrase, "device-secret")
    }

    func testClientIdentityStoreRecognizesOnlyTheIPhoneClientCertificateName() throws {
        XCTAssertTrue(ClientIdentityStore.isPreferredClientCertificateName("iphone"))
        XCTAssertTrue(ClientIdentityStore.isPreferredClientCertificateName(" IPHONE "))
        XCTAssertFalse(ClientIdentityStore.isPreferredClientCertificateName("parikshit-mac"))
        XCTAssertFalse(ClientIdentityStore.isPreferredClientCertificateName("client"))
    }

    func testCodexMarkdownParserBuildsBlockProseForHeadingsAndLists() throws {
        let blocks = CodexMarkdownParser.proseBlocks(
            from: """
            ## POC Vault

            This is a **private iOS POC vault**.

            ### Architecture

            - **Backend:** EC2 VM running nginx
            - POCs: Static files in `pocs/<slug>/public/`
            1. Render manifest
            2. Sign manifest
            """
        )

        XCTAssertEqual(blocks.map(\.kind), [
            .heading(level: 2),
            .paragraph,
            .heading(level: 3),
            .bullet,
            .bullet,
            .numbered(index: 1),
            .numbered(index: 2)
        ])
        XCTAssertEqual(blocks.map(\.text), [
            "POC Vault",
            "This is a **private iOS POC vault**.",
            "Architecture",
            "**Backend:** EC2 VM running nginx",
            "POCs: Static files in `pocs/<slug>/public/`",
            "Render manifest",
            "Sign manifest"
        ])
    }

    func testCodexMarkdownParserBuildsTableBlocksForPhoneFriendlyRendering() throws {
        let blocks = CodexMarkdownParser.proseBlocks(
            from: """
            ## Folder Structure

            | Path | What it is |
            |------|------------|
            | `pocs/` | The actual prototypes (7 POCs currently) |
            | `ops/` | Deployment tooling — deploy script, manifest renderer/signer, server provisioning, cert management, nginx config |

            ## Current POCs
            """
        )

        XCTAssertEqual(blocks.count, 3)
        XCTAssertEqual(blocks[0].kind, .heading(level: 2))
        if case .table(let header, let rows) = blocks[1].kind {
            XCTAssertEqual(header, ["Path", "What it is"])
            XCTAssertEqual(rows, [
                ["`pocs/`", "The actual prototypes (7 POCs currently)"],
                ["`ops/`", "Deployment tooling — deploy script, manifest renderer/signer, server provisioning, cert management, nginx config"]
            ])
        } else {
            XCTFail("Expected markdown table to parse as a table block")
        }
        XCTAssertEqual(blocks[2].kind, .heading(level: 2))

        let preview = CodexMarkdownParser.plainText(
            from: """
            | Path | What it is |
            |------|------------|
            | `pocs/` | The actual prototypes |
            """
        )
        XCTAssertEqual(preview, "Path What it is pocs/ The actual prototypes")
        XCTAssertFalse(preview.contains("|------|"))
    }

    private func decodeCodexJob(_ json: String) throws -> CodexJob {
        try JSONDecoder().decode(CodexJob.self, from: Data(json.utf8))
    }

    private func decodeCodexThread(_ json: String) throws -> CodexThread {
        try JSONDecoder().decode(CodexThread.self, from: Data(json.utf8))
    }

    private var codexConsoleSourcePath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("POCVault/Views/CodexConsoleView.swift")
            .path
    }

    private var appSourcePath: String {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("POCVault/POCVaultApp.swift")
            .path
    }

    private func sourceSnippet(in source: String, from startMarker: String, to endMarker: String) throws -> String {
        guard
            let start = source.range(of: startMarker),
            let end = source.range(of: endMarker, range: start.upperBound..<source.endIndex)
        else {
            throw XCTSkip("Missing source markers: \(startMarker) -> \(endMarker)")
        }
        return String(source[start.lowerBound..<end.lowerBound])
    }

    private func assertColor(
        _ color: Color,
        red: Int,
        green: Int,
        blue: Int,
        alpha: CGFloat,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        let uiColor = UIColor(color)
        var actualRed: CGFloat = 0
        var actualGreen: CGFloat = 0
        var actualBlue: CGFloat = 0
        var actualAlpha: CGFloat = 0

        XCTAssertTrue(
            uiColor.getRed(&actualRed, green: &actualGreen, blue: &actualBlue, alpha: &actualAlpha),
            "Could not resolve color components",
            file: file,
            line: line
        )
        XCTAssertEqual(actualRed, CGFloat(red) / 255.0, accuracy: 0.003, file: file, line: line)
        XCTAssertEqual(actualGreen, CGFloat(green) / 255.0, accuracy: 0.003, file: file, line: line)
        XCTAssertEqual(actualBlue, CGFloat(blue) / 255.0, accuracy: 0.003, file: file, line: line)
        XCTAssertEqual(actualAlpha, alpha, accuracy: 0.003, file: file, line: line)
    }
}
