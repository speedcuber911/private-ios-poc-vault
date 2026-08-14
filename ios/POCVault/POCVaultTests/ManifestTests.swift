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
        XCTAssertEqual(CodexProvider.codex.defaultModel, "")
        XCTAssertEqual(CodexProvider.codex.modelOptions, [])
        XCTAssertEqual(CodexProvider.codex.defaultReasoningEffort, .xhigh)

        XCTAssertEqual(CodexProvider.claude.displayName, "Claude")
        XCTAssertEqual(CodexProvider.claude.defaultModel, "")
        XCTAssertEqual(CodexProvider.claude.modelOptions, [])
        XCTAssertEqual(CodexProvider.claude.defaultReasoningEffort, .high)
        XCTAssertEqual(CodexProvider.claude.reasoningEffortOptions, CodexReasoningEffort.allCases)
    }

    func testCodexModelDescriptorAllowsOptionalEffortLevels() throws {
        let json = """
        {
          "id": "gpt-4o",
          "label": "GPT-4o (Azure)",
          "provider": "azure",
          "modes": ["chat"],
          "azureDeployment": "gpt-4o",
          "defaultOptions": { "temperature": 0.7, "maxTokens": 4096 }
        }
        """.data(using: .utf8)!

        let model = try JSONDecoder().decode(CodexModelDescriptor.self, from: json)

        XCTAssertEqual(model.id, "gpt-4o")
        XCTAssertEqual(model.provider, .azure)
        XCTAssertTrue(model.supports(.chat))
        XCTAssertEqual(model.effortLevels, [])
    }

    @MainActor
    func testRelayModelSelectionStaysEmptyWithEmptyCatalog() throws {
        let suiteName = "relay-empty-models-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let client = CodexClient(
            baseURL: try XCTUnwrap(URL(string: "http://127.0.0.1:8787")),
            identityStore: ClientIdentityStore(defaults: defaults)
        )
        let viewModel = RelayChatViewModel(client: client, workspaceID: nil, workspacePath: nil)

        XCTAssertNil(viewModel.selectedChoice)
        XCTAssertTrue(viewModel.pickerSections.isEmpty)
        XCTAssertNil(viewModel.pickerSections.defaultChoice)
        XCTAssertTrue(viewModel.availableEfforts.isEmpty)
        XCTAssertNil(viewModel.effectiveEffort)
    }

    func testCodexSSEParserDecodesEventsWithoutBlankSeparators() throws {
        var parser = CodexSSELineParser()
        var events: [CodexChatEvent] = []

        events.append(contentsOf: parser.ingest("event: meta"))
        events.append(contentsOf: parser.ingest("data: {\"threadId\":\"thread-1\",\"model\":\"gpt-4o\",\"provider\":\"azure\"}"))
        events.append(contentsOf: parser.ingest("event: delta"))
        events.append(contentsOf: parser.ingest("data: {\"text\":\"hello\"}"))
        events.append(contentsOf: parser.ingest("event: done"))
        events.append(contentsOf: parser.ingest("data: {\"stopReason\":\"stop\"}"))
        events.append(contentsOf: parser.finish())

        XCTAssertEqual(events, [
            .meta(threadId: "thread-1", model: "gpt-4o", provider: "azure"),
            .delta("hello"),
            .done("stop")
        ])
    }

    func testCodexSSEParserFlushesFinalEventAtEOF() throws {
        var parser = CodexSSELineParser()
        var events: [CodexChatEvent] = []

        events.append(contentsOf: parser.ingest("event: delta"))
        events.append(contentsOf: parser.ingest("data: {\"text\":\"last token\"}"))
        events.append(contentsOf: parser.finish())

        XCTAssertEqual(events, [.delta("last token")])
    }

    /// The live seven-entry catalog shape: Codex dual-mode Sol/Terra/Luna, Claude Code
    /// task trio, Cursor Auto. Agents groups by harness; chat models stay flat.
    func testRelayModelDiscoveryGroupsAgentsByHarness() throws {
        let models = try decodeCodexModels(liveShapeCatalogJSON)

        let sections = RelayModelDiscovery.sections(from: models)

        XCTAssertEqual(sections.agents.map(\.provider), [.codex, .claude, .cursor])
        XCTAssertEqual(sections.agents.map(\.title), ["Codex", "Claude Code", "Cursor"])
        XCTAssertEqual(
            sections.agents[0].choices.map(\.model.id),
            ["codex-gpt-5.6-sol", "codex-gpt-5.6-terra", "codex-gpt-5.6-luna"]
        )
        XCTAssertEqual(
            sections.agents[1].choices.map(\.shortModelLabel),
            ["Sonnet", "Opus", "Haiku"]
        )
        XCTAssertTrue(sections.agents.flatMap(\.choices).allSatisfy { $0.mode == .task })

        // Chat models: only the chat-capable Codex trio (no Azure advertised here).
        XCTAssertEqual(
            sections.chatModels.map(\.model.id),
            ["codex-gpt-5.6-sol", "codex-gpt-5.6-terra", "codex-gpt-5.6-luna"]
        )
        XCTAssertTrue(sections.chatModels.allSatisfy { $0.mode == .chat })
    }

    /// A harness missing from the catalog produces no group — the client never
    /// synthesizes providers. A single-entry harness (Cursor Auto) shows exactly one row.
    func testRelayModelDiscoveryOmitsMissingHarnessesAndNeverSynthesizesRows() throws {
        let withoutCursor = try decodeCodexModels(
            """
            [
              { "id": "codex-gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-sol" },
              { "id": "claude-code-opus", "label": "Claude Code · Opus", "provider": "claude", "modes": ["task"], "taskModel": "opus" }
            ]
            """
        )
        let trimmed = RelayModelDiscovery.sections(from: withoutCursor)
        XCTAssertEqual(trimmed.agents.map(\.provider), [.codex, .claude])
        XCTAssertFalse(trimmed.agents.contains { $0.provider == .cursor })

        let full = RelayModelDiscovery.sections(from: try decodeCodexModels(liveShapeCatalogJSON))
        let cursorGroup = try XCTUnwrap(full.agents.first { $0.provider == .cursor })
        XCTAssertEqual(cursorGroup.choices.count, 1)
        XCTAssertEqual(cursorGroup.choices[0].shortModelLabel, "Auto")
        XCTAssertEqual(cursorGroup.choices[0].chipLabel, "Cursor · Auto")

        XCTAssertTrue(RelayModelDiscovery.sections(from: []).isEmpty)
    }

    /// An Azure catalog entry (fixture-style) is chat-only: it lands in Chat models,
    /// never under Agents, and its jobs would route through the Codex runner.
    func testRelayModelDiscoveryRoutesAzureEntriesToChatModels() throws {
        let models = try decodeCodexModels(
            """
            [
              { "id": "gpt-4o", "label": "GPT-4o (Azure)", "provider": "azure", "modes": ["chat"], "azureDeployment": "gpt-4o" },
              { "id": "codex-gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-sol" }
            ]
            """
        )

        let sections = RelayModelDiscovery.sections(from: models)

        XCTAssertFalse(sections.agents.contains { $0.provider == .azure })
        let azureChoice = try XCTUnwrap(sections.chatModels.first { $0.model.provider == .azure })
        XCTAssertEqual(azureChoice.mode, .chat)
        XCTAssertEqual(azureChoice.shortModelLabel, "GPT-4o")
        XCTAssertEqual(azureChoice.chipLabel, "Azure · GPT-4o")
    }

    /// Task jobs are routed by harness: Cursor keeps its own runner, Azure/dual-mode
    /// Codex descriptors run on the Codex runner, Bedrock aliases run through Claude.
    func testRelayTaskProviderRoutingIsHarnessSpecific() throws {
        let models = try decodeCodexModels(
            """
            [
              { "id": "cursor-agent-auto", "label": "Cursor Agent · Auto", "provider": "cursor", "modes": ["task"], "taskModel": "auto" },
              { "id": "codex-gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-sol" },
              { "id": "claude-code-opus", "label": "Claude Code · Opus", "provider": "claude", "modes": ["task"], "taskModel": "opus" },
              { "id": "gpt-4o", "label": "GPT-4o (Azure)", "provider": "azure", "modes": ["chat"], "azureDeployment": "gpt-4o" },
              { "id": "bedrock-opus", "label": "Claude Opus (Bedrock)", "provider": "bedrock", "modes": ["task"] }
            ]
            """
        )

        XCTAssertEqual(RelayChatViewModel.taskProvider(for: models[0]), .cursor)
        XCTAssertEqual(RelayChatViewModel.taskProvider(for: models[1]), .codex)
        XCTAssertEqual(RelayChatViewModel.taskProvider(for: models[2]), .claude)
        XCTAssertEqual(RelayChatViewModel.taskProvider(for: models[3]), .codex)
        XCTAssertEqual(RelayChatViewModel.taskProvider(for: models[4]), .claude)

        XCTAssertEqual(RelayChatViewModel.taskModelParameter(for: models[0]), "auto")
        XCTAssertEqual(RelayChatViewModel.taskModelParameter(for: models[1]), "gpt-5.6-sol")
        XCTAssertEqual(RelayChatViewModel.taskModelParameter(for: models[2]), "opus")
        // Bedrock alias without a taskModel and without chat support: runner default.
        XCTAssertNil(RelayChatViewModel.taskModelParameter(for: models[4]))
    }

    /// A dual-mode Codex model is selectable as either an agent (task) or a chat model,
    /// with the explicit mode preserved on the selection and distinct identities.
    @MainActor
    func testRelayDualModeModelSelectsAsEitherChatOrTask() throws {
        let models = try decodeCodexModels(
            """
            [
              { "id": "codex-gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-sol", "effortLevels": ["low", "medium", "high", "xhigh"] }
            ]
            """
        )
        let model = try XCTUnwrap(models.first)
        let viewModel = RelayChatViewModel(
            client: makeOfflineCodexClient(),
            workspaceID: "ws-alpha",
            workspacePath: "/srv/codex-workspaces/alpha"
        )

        viewModel.selectChoice(RelayModelChoice(model: model, mode: .chat))
        XCTAssertEqual(viewModel.selectedChoice?.mode, .chat)
        let chatID = try XCTUnwrap(viewModel.selectedChoice?.id)
        // Chat requests carry no reasoning effort, so chat selections expose none.
        XCTAssertTrue(viewModel.availableEfforts.isEmpty)

        viewModel.selectChoice(RelayModelChoice(model: model, mode: .task))
        XCTAssertEqual(viewModel.selectedChoice?.mode, .task)
        let taskID = try XCTUnwrap(viewModel.selectedChoice?.id)
        XCTAssertEqual(viewModel.availableEfforts, [.low, .medium, .high, .xhigh])

        XCTAssertNotEqual(chatID, taskID)
    }

    /// First send in an unregistered folder registers lazily; when registration fails the
    /// composer shows an error banner and the typed prompt survives untouched.
    @MainActor
    func testRelayLazyWorkspaceRegistrationFailurePreservesPrompt() async throws {
        let models = try decodeCodexModels(
            """
            [
              { "id": "codex-gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-sol" }
            ]
            """
        )
        let model = try XCTUnwrap(models.first)
        let viewModel = RelayChatViewModel(
            client: makeOfflineCodexClient(),
            workspaceID: nil,
            workspacePath: "/srv/codex-workspaces/unregistered"
        )

        viewModel.selectChoice(RelayModelChoice(model: model, mode: .task))
        viewModel.prompt = "Ship the fix"
        await viewModel.sendCurrentPrompt()

        XCTAssertEqual(viewModel.prompt, "Ship the fix", "Failed registration must not drop the draft")
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertNil(viewModel.workspaceID)
        XCTAssertFalse(viewModel.isSending)
        XCTAssertTrue(viewModel.messages.isEmpty, "No conversation items before the folder registers")

        // Chat mode in the same unregistered folder takes the same lazy path.
        viewModel.errorMessage = nil
        viewModel.selectChoice(RelayModelChoice(model: model, mode: .chat))
        await viewModel.sendCurrentPrompt()

        XCTAssertEqual(viewModel.prompt, "Ship the fix")
        XCTAssertNotNil(viewModel.errorMessage)
        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    /// Live-catalog-shaped fixture used by the harness grouping tests.
    private var liveShapeCatalogJSON: String {
        """
        [
          { "id": "codex-gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-sol", "effortLevels": ["low", "medium", "high", "xhigh"] },
          { "id": "codex-gpt-5.6-terra", "label": "Codex · GPT-5.6 Terra", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-terra", "effortLevels": ["low", "medium", "high", "xhigh"] },
          { "id": "codex-gpt-5.6-luna", "label": "Codex · GPT-5.6 Luna", "provider": "codex", "modes": ["chat", "task"], "taskModel": "gpt-5.6-luna", "effortLevels": ["low", "medium", "high", "xhigh"] },
          { "id": "claude-code-sonnet", "label": "Claude Code · Sonnet", "provider": "claude", "modes": ["task"], "taskModel": "sonnet", "effortLevels": ["low", "medium", "high"] },
          { "id": "claude-code-opus", "label": "Claude Code · Opus", "provider": "claude", "modes": ["task"], "taskModel": "opus", "effortLevels": ["low", "medium", "high"] },
          { "id": "claude-code-haiku", "label": "Claude Code · Haiku", "provider": "claude", "modes": ["task"], "taskModel": "haiku", "effortLevels": ["low", "medium", "high"] },
          { "id": "cursor-agent-auto", "label": "Cursor Agent · Auto", "provider": "cursor", "modes": ["task"], "taskModel": "auto", "effortLevels": [] }
        ]
        """
    }

    func testCodexProviderTabIconsUseBrandAssets() throws {
        XCTAssertEqual(CodexProvider.codex.tabIconAssetName, "ChatGPTMark")
        XCTAssertEqual(CodexProvider.claude.tabIconAssetName, "ClaudeMark")
    }

    func testRelayDesignTokensUseEditorialEmberPalette() throws {
        assertColor(AppTheme.canvasTop, red: 0x1E, green: 0x1B, blue: 0x17, alpha: 1)
        assertColor(AppTheme.canvasBottom, red: 0x15, green: 0x13, blue: 0x10, alpha: 1)
        assertColor(AppTheme.bgCanvas, red: 0x1A, green: 0x18, blue: 0x15, alpha: 1)
        assertColor(AppTheme.textPrimary, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 1)
        assertColor(AppTheme.textSecondary, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.55)
        assertColor(AppTheme.textTertiary, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.38)
        assertColor(AppTheme.textFaint, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.25)
        assertColor(AppTheme.hairline, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.10)
        assertColor(AppTheme.hairlineStrong, red: 0xED, green: 0xE8, blue: 0xDF, alpha: 0.16)
        assertColor(AppTheme.accent, red: 0xD4, green: 0x80, blue: 0x4A, alpha: 1)
        assertColor(AppTheme.accentBright, red: 0xE8, green: 0x96, blue: 0x5C, alpha: 1)
        assertColor(AppTheme.accentDeep, red: 0xC9, green: 0x6F, blue: 0x35, alpha: 1)
        assertColor(AppTheme.onEmber, red: 0x1C, green: 0x12, blue: 0x07, alpha: 1)
        assertColor(AppTheme.statusWarn, red: 0xE0, green: 0xB2, blue: 0x5C, alpha: 1)
        assertColor(AppTheme.statusError, red: 0xD9, green: 0x77, blue: 0x6B, alpha: 1)
    }

    /// Editorial Ember rule 5: status is a small-caps word, never a colored dot, and
    /// success renders in cream rather than green. Guards against reintroducing the
    /// blob-pill/indicator-dot pattern the redesign removed.
    func testStatusIndicatorsStayTypographic() throws {
        let files: [(name: String, relative: String)] = [
            ("POCVaultApp.swift", "POCVault/POCVaultApp.swift"),
            ("RelayChatView.swift", "POCVault/Views/RelayChatView.swift"),
            ("FileBrowserView.swift", "POCVault/Browser/FileBrowserView.swift"),
            ("DiagnosticsView.swift", "POCVault/Views/DiagnosticsView.swift"),
        ]
        for file in files {
            let source = try AppSourceFixture.load(file.relative)

            // The retired green/amber status tokens are gone from AppTheme entirely.
            XCTAssertFalse(source.contains("statusOK"), "\(file.name) still references statusOK")
            XCTAssertFalse(source.contains("statusNeutral"), "\(file.name) still references statusNeutral")
            XCTAssertFalse(source.contains("statusInfo"), "\(file.name) still references statusInfo")

            // No status shape: a filled circle tinted by a status color is the exact
            // pattern the redesign replaced with RelayCapsLabel.
            XCTAssertFalse(
                source.contains("Circle().fill(AppTheme.status"),
                "\(file.name) renders a colored status dot"
            )
            XCTAssertFalse(
                source.contains("checkmark.circle.fill"),
                "\(file.name) renders a status glyph instead of a status word"
            )
        }

        // Job status renders as a ticking typographic label.
        let chatSource = try AppSourceFixture.load("POCVault/Views/RelayChatView.swift")
        XCTAssertTrue(chatSource.contains("RelayCapsLabel"))
        XCTAssertTrue(chatSource.contains("TimelineView"))
    }

    func testRootUsesThreeNativeTabsWhileKeepingFileBrowserNavigation() throws {
        let source = try AppSourceFixture.load("POCVault/POCVaultApp.swift")
        let browserSource = try AppSourceFixture.load("POCVault/Browser/FileBrowserView.swift")

        // Workspaces keeps its real BrowserRoute navigation inside the new, deliberately
        // small Workspaces / Sessions / Settings information architecture.
        XCTAssertTrue(source.contains("NavigationStack(path: $browserPath)"))
        XCTAssertTrue(source.contains(".navigationDestination(for: BrowserRoute.self)"))
        XCTAssertTrue(source.contains("case folder(path: String)"))
        XCTAssertTrue(source.contains("case file(entry: CodexWorkspaceDirectoryEntry)"))
        XCTAssertTrue(source.contains("FileViewerView("))
        XCTAssertFalse(source.contains("FileViewerPlaceholderView"))
        XCTAssertTrue(source.contains("TabView(selection: $selectedRootTab)"))
        XCTAssertTrue(source.contains("Label(\"Workspaces\""))
        XCTAssertTrue(source.contains("Label(\"Sessions\""))
        XCTAssertTrue(source.contains("Label(\"Settings\""))
        XCTAssertTrue(source.contains("RelayRootTab"))
        XCTAssertFalse(source.contains("RelayTabBar"))

        // Settings and profile are root tabs only; the workspace menu does not
        // duplicate them as separate destinations.
        XCTAssertFalse(browserSource.contains("Label(\"Account & Settings\""))
        XCTAssertFalse(browserSource.contains("Label(\"Status\""))

        // Library embeds its own NavigationStack, so it presents as a full-screen cover
        // (nesting stacks is illegal); Diagnostics stays a sheet and chat a cover.
        XCTAssertTrue(source.contains(".fullScreenCover(isPresented: $showingLibrary)"))
        XCTAssertTrue(source.contains(".fullScreenCover(item: $chatLaunch)"))
        XCTAssertFalse(source.contains(".sheet(isPresented: $showingStatus)"))
        XCTAssertTrue(source.contains(".sheet(isPresented: $showingDiagnostics)"))

        // Job monitoring runs app-wide through the session store, still policy-guarded.
        XCTAssertTrue(source.contains("chatSessionStore.monitorActiveWorkWhileAppIsOpen()"))
        XCTAssertTrue(source.contains("CodexAgentMonitorPolicy.shouldStartAppMonitor"))

        // Deep-link hooks still use semantic destinations rather than a numeric tab id.
        XCTAssertFalse(source.contains("RELAY_UITEST_TAB"))
        XCTAssertTrue(source.contains("RELAY_UITEST_PATH"))
        XCTAssertTrue(source.contains("RELAY_UITEST_FILE"))
        XCTAssertTrue(source.contains("RELAY_UITEST_CHAT"))
        XCTAssertTrue(source.contains("RELAY_UITEST_OPEN"))
    }

    @MainActor
    func testRelayChatSessionStoreReusesAndEvictsLeastRecentlyUsedSessions() async throws {
        let store = RelayChatSessionStore(
            client: makeOfflineCodexClient(),
            capacity: 2,
            isPinned: { _ in false }
        )

        XCTAssertEqual(RelayChatSessionStore.canonicalKey(forFolderPath: nil), RelayChatSessionStore.rootKey)
        XCTAssertEqual(RelayChatSessionStore.canonicalKey(forFolderPath: "  "), RelayChatSessionStore.rootKey)
        XCTAssertEqual(
            RelayChatSessionStore.canonicalKey(forFolderPath: "/srv/codex-workspaces/alpha/"),
            RelayChatSessionStore.canonicalKey(forFolderPath: "/srv/codex-workspaces/alpha")
        )

        let alpha = store.session(forFolderPath: "/srv/codex-workspaces/alpha", workspaceID: "ws-alpha")
        let alphaAgain = store.session(forFolderPath: "/srv/codex-workspaces/alpha/", workspaceID: "ws-alpha")
        XCTAssertTrue(alpha === alphaAgain, "Same canonical folder must reuse the cached view model")
        XCTAssertEqual(store.cachedSessionCount, 1)
        XCTAssertEqual(alpha.workspaceID, "ws-alpha")
        XCTAssertEqual(alpha.workspacePath, "/srv/codex-workspaces/alpha")
        XCTAssertEqual(alpha.folderDisplayName, "alpha")

        store.session(forFolderPath: "/srv/codex-workspaces/beta", workspaceID: "ws-beta")
        XCTAssertEqual(store.cachedSessionCount, 2)

        // Touch alpha so beta becomes least recently used, then exceed the cap.
        store.session(forFolderPath: "/srv/codex-workspaces/alpha", workspaceID: "ws-alpha")
        store.session(forFolderPath: "/srv/codex-workspaces/gamma", workspaceID: "ws-gamma")

        XCTAssertEqual(store.cachedSessionCount, 2)
        XCTAssertNotNil(store.cachedSession(forFolderPath: "/srv/codex-workspaces/alpha"))
        XCTAssertNil(store.cachedSession(forFolderPath: "/srv/codex-workspaces/beta"))
        XCTAssertNotNil(store.cachedSession(forFolderPath: "/srv/codex-workspaces/gamma"))
    }

    @MainActor
    func testRelayChatSessionStorePinsActiveSessionsDuringEviction() async throws {
        var pinnedViewModels: Set<ObjectIdentifier> = []
        let store = RelayChatSessionStore(
            client: makeOfflineCodexClient(),
            capacity: 1,
            isPinned: { pinnedViewModels.contains(ObjectIdentifier($0)) }
        )

        let pinned = store.session(forFolderPath: "/srv/codex-workspaces/streaming", workspaceID: "ws-streaming")
        pinnedViewModels.insert(ObjectIdentifier(pinned))

        store.session(forFolderPath: "/srv/codex-workspaces/idle", workspaceID: "ws-idle")

        // Over capacity, but the pinned (streaming/active-job) session must survive.
        XCTAssertEqual(store.cachedSessionCount, 2)
        XCTAssertTrue(store.cachedSession(forFolderPath: "/srv/codex-workspaces/streaming") === pinned)

        // Unpin it; the next insertion evicts the now-unpinned LRU entries down to cap.
        pinnedViewModels.removeAll()
        store.session(forFolderPath: "/srv/codex-workspaces/next", workspaceID: "ws-next")

        XCTAssertEqual(store.cachedSessionCount, 1)
        XCTAssertNil(store.cachedSession(forFolderPath: "/srv/codex-workspaces/streaming"))
        XCTAssertNil(store.cachedSession(forFolderPath: "/srv/codex-workspaces/idle"))
        XCTAssertNotNil(store.cachedSession(forFolderPath: "/srv/codex-workspaces/next"))
    }

    /// A client pointed at a closed local port: constructing view models never fires
    /// requests, and anything fired by mistake fails fast without leaving the machine.
    private func makeOfflineCodexClient() -> CodexClient {
        CodexClient(
            baseURL: URL(string: "http://127.0.0.1:9")!,
            identityStore: ClientIdentityStore()
        )
    }

    func testLibraryRecentFilterShowsEmptyStateInsteadOfAllEntries() throws {
        let source = try AppSourceFixture.load("POCVault/Views/LibraryView.swift")
        let filterSource = try sourceSnippet(
            in: source,
            from: "private func filteredEntries",
            to: "private var emptyState"
        )
        let emptyStateSource = try sourceSnippet(
            in: source,
            from: "private var emptyState",
            to: "private func markRecent"
        )

        XCTAssertFalse(filterSource.contains("recentEntries.isEmpty ? entries : recentEntries"))
        XCTAssertTrue(filterSource.contains("return recentEntries"))
        XCTAssertTrue(emptyStateSource.contains("No recent prototypes"))
        XCTAssertTrue(emptyStateSource.contains("Nothing in the library matches"))
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

    func testCodexJobDecodesWaitingForApprovalAsActiveAttention() throws {
        let job = try decodeCodexJob(
            """
            {
              "id": "job-waiting",
              "workspaceId": "scratch",
              "status": "waiting_for_approval",
              "provider": "codex"
            }
            """
        )

        XCTAssertEqual(job.status, .waitingForApproval)
        XCTAssertTrue(job.status.isActive)
        XCTAssertTrue(job.status.needsAttention)
    }

    func testCodexApprovalDecodesSanitizedRuntimePayload() throws {
        let data = Data(
            """
            {
              "id": "approval-1",
              "jobId": "job-waiting",
              "provider": "codex",
              "kind": "command",
              "title": "Run command",
              "reason": "Needs access outside the workspace",
              "command": "npm test",
              "cwd": "/srv/workspace",
              "toolName": null,
              "createdAt": "2026-08-14T10:50:36.581Z",
              "status": "pending",
              "availableDecisions": ["accept", "decline", "cancel"],
              "resolution": null
            }
            """.utf8
        )

        let approval = try CodexClient.makeDecoder().decode(CodexApproval.self, from: data)

        XCTAssertEqual(approval.id, "approval-1")
        XCTAssertEqual(approval.provider, .codex)
        XCTAssertEqual(approval.command, "npm test")
        XCTAssertTrue(approval.isPending)
        XCTAssertNotNil(approval.createdAt)
    }

    func testCodexTerminalDecodesLiveRuntimePayload() throws {
        let data = Data(
            """
            {
              "id": "terminal-1",
              "workspaceId": "scratch",
              "workspaceName": "Scratch",
              "status": "running",
              "createdAt": "2026-08-14T10:50:36.581Z",
              "updatedAt": "2026-08-14T10:50:37.000Z",
              "finishedAt": null,
              "exitCode": null,
              "cols": 80,
              "rows": 24
            }
            """.utf8
        )

        let terminal = try CodexClient.makeDecoder().decode(CodexTerminal.self, from: data)

        XCTAssertEqual(terminal.workspaceId, "scratch")
        XCTAssertEqual(terminal.cols, 80)
        XCTAssertTrue(terminal.isRunning)
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
                  "model": "azure-o-series-prod/gpt-5.5",
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
        XCTAssertEqual(thread.model, "azure-o-series-prod/gpt-5.5")
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

    func testCodexThreadDetailDecodesThreadMessagesAndJobs() throws {
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

        XCTAssertEqual(detail.thread.sessionId, "019e46a5-0000-7000-8000-000000000001")
        XCTAssertEqual(detail.thread.workspaceId, "poc-vault")
        XCTAssertEqual(detail.messages.map(\.role), [.user, .assistant, .user])
        XCTAssertEqual(detail.messages.map(\.text), ["First thing I asked", "First Codex answer", "Second follow up"])
        XCTAssertTrue(detail.jobs.isEmpty)

        // Missing messages/jobs decode leniently to empty arrays.
        let sparse = try JSONDecoder().decode(
            CodexThreadDetail.self,
            from: Data(
                """
                {
                  "thread": {
                    "id": "019e46a5-0000-7000-8000-000000000002",
                    "sessionId": "019e46a5-0000-7000-8000-000000000002"
                  }
                }
                """.utf8
            )
        )
        XCTAssertTrue(sparse.messages.isEmpty)
        XCTAssertTrue(sparse.jobs.isEmpty)
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

    func testCodexThreadFeedKeepsEveryStandaloneInvocationInHistory() throws {
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
        let succeededOrphanJob = try decodeCodexJob(
            """
            {
              "id": "job-finished-without-session",
              "status": "succeeded",
              "workspaceId": "scratch",
              "workspaceName": "Scratch",
              "prompt": "Summarize the repository",
              "result": "Summary complete.",
              "updatedAt": "2026-05-21T07:35:00Z"
            }
            """
        )

        let feed = CodexThreadFeedItem.makeFeed(
            threads: [],
            jobs: [oldOrphanJob, succeededOrphanJob, activeJob]
        )

        XCTAssertEqual(feed.count, 3)
        XCTAssertEqual(feed.first?.jobID, "job-starting")
        XCTAssertTrue(feed.first?.isPendingSession == true)
        XCTAssertEqual(feed.first?.title, "Check deployment health")
        XCTAssertTrue(feed.first?.preview.contains("Starting on EC2") == true)
        XCTAssertEqual(feed[1].jobID, "job-finished-without-session")
        XCTAssertEqual(feed[1].preview, "Summary complete.")
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

    func testCodexCreateJobRequestKeepsProviderPermissionsAndSkillsIndependent() throws {
        let request = CodexCreateJobRequest(
            workspaceId: "scratch",
            prompt: "use my configured workflow",
            timeoutMs: 120_000,
            model: "sonnet",
            provider: .claude,
            permissionMode: "acceptEdits",
            skills: ["claude-debug", "superpowers:tdd"]
        )

        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]

        XCTAssertEqual(payload?["provider"] as? String, "claude")
        XCTAssertEqual(payload?["permissionMode"] as? String, "acceptEdits")
        XCTAssertEqual(payload?["skills"] as? [String], ["claude-debug", "superpowers:tdd"])
    }

    func testCodexCreateJobRequestEncodesProviderSpecificApprovalPolicy() throws {
        let request = CodexCreateJobRequest(
            workspaceId: "scratch",
            prompt: "run the checks",
            timeoutMs: 120_000,
            model: "gpt-5.5",
            provider: .codex,
            approvalPolicy: "on-request"
        )

        let payload = try JSONSerialization.jsonObject(with: JSONEncoder().encode(request)) as? [String: Any]

        XCTAssertEqual(payload?["provider"] as? String, "codex")
        XCTAssertEqual(payload?["approvalPolicy"] as? String, "on-request")
        XCTAssertNil(payload?["permissionMode"])
    }

    func testRelaySlashContextWorksAfterWhitespaceAndUsesTheCurrentCaret() throws {
        let text = "Keep this paragraph.\nThen /review the current diff."
        let caret = try XCTUnwrap(text.range(of: "/rev")?.upperBound)
        let location = text.utf16.distance(from: text.utf16.startIndex, to: caret.samePosition(in: text.utf16)!)

        let context = try XCTUnwrap(RelaySlashContext.find(
            in: text,
            selection: NSRange(location: location, length: 0)
        ))

        XCTAssertEqual(context.query, "rev")
        XCTAssertEqual((text as NSString).substring(with: context.range), "/review")
    }

    func testRelaySlashContextDoesNotTreatURLOrPathSlashAsACommand() throws {
        let text = "Open https://example.com/docs"
        let location = (text as NSString).length

        XCTAssertNil(RelaySlashContext.find(
            in: text,
            selection: NSRange(location: location, length: 0)
        ))
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

    func testIsCancellationTreatsSwiftCancellationAsNonError() throws {
        XCTAssertTrue(isCancellation(CancellationError()))
    }

    func testIsCancellationTreatsURLSessionCancellationAsNonError() throws {
        XCTAssertTrue(isCancellation(URLError(.cancelled)))
        XCTAssertFalse(isCancellation(URLError(.notConnectedToInternet)))
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

    func testRelayChatUsesStructuredMarkdownRendering() throws {
        // The markdown views were promoted out of RelayChatView (revamp I3) into
        // Rendering/RelayMarkdownViews.swift so chat and the file viewer share them.
        let markdownSource = try AppSourceFixture.load("POCVault/Rendering/RelayMarkdownViews.swift")
        XCTAssertTrue(markdownSource.contains("struct RelayMarkdownText"))
        XCTAssertTrue(markdownSource.contains("struct RelayMarkdownProse"))
        XCTAssertTrue(markdownSource.contains("struct RelayMarkdownTable"))
        XCTAssertTrue(markdownSource.contains("struct RelayCodeBlock"))
        XCTAssertTrue(markdownSource.contains("CodexMarkdownParser.segments"))
        XCTAssertFalse(markdownSource.contains("private struct RelayMarkdownText"))
        XCTAssertFalse(markdownSource.contains("RelayTextPart.parse(text)"))

        // Chat still renders through the shared entry point instead of a private copy.
        let chatSource = try AppSourceFixture.load("POCVault/Views/RelayChatView.swift")
        XCTAssertTrue(chatSource.contains("RelayMarkdownText(text:"))
        XCTAssertFalse(chatSource.contains("struct RelayMarkdownText"))

        // The file viewer's rendered-markdown mode consumes the same shared views.
        let viewerSource = try AppSourceFixture.load("POCVault/Browser/FileViewerView.swift")
        XCTAssertTrue(viewerSource.contains("RelayMarkdownText(text:"))
    }

    func testRelayComposerDoesNotReserveExtraKeyboardGap() throws {
        let source = try AppSourceFixture.load("POCVault/Views/RelayChatView.swift")
        let composerSource = try sourceSnippet(
            in: source,
            from: "private struct RelayComposer",
            to: "private struct RelayChatBubble"
        )

        XCTAssertFalse(composerSource.contains("ToolbarItemGroup(placement: .keyboard)"))
        XCTAssertFalse(composerSource.contains("keyboard.chevron.compact.down"))
        XCTAssertTrue(composerSource.contains("isFocused = false"))
        XCTAssertFalse(composerSource.contains("keyboardAccessoryClearance"))
        XCTAssertFalse(composerSource.contains(".padding(.bottom, isFocused ?"))

        XCTAssertTrue(source.contains("TapGesture().onEnded"))
        XCTAssertTrue(source.contains("dismissKeyboard()"))
        XCTAssertTrue(source.contains("#selector(UIResponder.resignFirstResponder)"))
    }

    /// Revamp I4: the composer is harness-first. The mode toggle, workspace chip, and
    /// the in-chat workspace browser are gone (the file browser owns folder navigation);
    /// the picker groups Agents per harness with a flat Chat models section; the send
    /// icon is always `arrow.up`; the keyboard-dismissal invariants survive.
    func testRelayChatComposerIsHarnessFirstWithoutModeToggle() throws {
        let source = try AppSourceFixture.load("POCVault/Views/RelayChatView.swift")

        // Dead controls from the mode-toggle era.
        XCTAssertFalse(source.contains("RelayWorkspaceSheet"))
        XCTAssertFalse(source.contains("RelayFolderRow"))
        XCTAssertFalse(source.contains("showingOptions"))
        XCTAssertFalse(source.contains("relay-workspace-chip"))
        XCTAssertFalse(source.contains("Picker(\"Mode\""))
        XCTAssertFalse(source.contains("showsModeToggle"))
        XCTAssertFalse(source.contains("RELAY_UITEST_WS_PATH"))
        XCTAssertFalse(source.contains("play.fill"))
        XCTAssertFalse(source.contains("threadsByWorkspace"))

        // Harness-first picker: Agents submenus per harness + flat Chat models.
        XCTAssertTrue(source.contains("Section(\"Agents\")"))
        XCTAssertTrue(source.contains("Section(\"Chat models\")"))
        XCTAssertTrue(source.contains("ForEach(sections.agents)"))
        XCTAssertTrue(source.contains("Menu(harness.title)"))
        XCTAssertTrue(source.contains("ForEach(sections.chatModels)"))
        XCTAssertTrue(source.contains("relay-model-chip"))
        XCTAssertTrue(source.contains("relay-effort-chip"))
        XCTAssertTrue(source.contains("Image(systemName: \"arrow.up\")"))

        // Live SSE-fed job tail with the poll-driven fallback text.
        XCTAssertTrue(source.contains("liveTail"))
        XCTAssertTrue(source.contains("viewModel.liveJobTails[job.id]"))

        // Keyboard invariants (AGENTS.md hard requirement).
        XCTAssertTrue(source.contains(".scrollDismissesKeyboard(.interactively)"))
        XCTAssertTrue(source.contains("TapGesture().onEnded"))
        XCTAssertTrue(source.contains("dismissKeyboard()"))
        XCTAssertFalse(source.contains("ToolbarItemGroup(placement: .keyboard)"))
    }

    func testRelayFolderHistoryIncludesStandaloneInvocationsAndFullLogSheetHasStableIdentity() throws {
        let source = try AppSourceFixture.load("POCVault/Views/RelayChatView.swift")
        let viewModelSource = try AppSourceFixture.load("POCVault/Views/RelayChatViewModel.swift")

        XCTAssertTrue(source.contains("ForEach(viewModel.historyItems)"))
        XCTAssertTrue(source.contains("Section(\"This folder\")"))
        XCTAssertFalse(source.contains("All conversations & invocations"))
        XCTAssertTrue(source.contains("item.workspaceLabel"))
        XCTAssertTrue(source.contains("await viewModel.openHistoryItem(item)"))
        XCTAssertTrue(source.contains("Text(\"Threads\")"))
        // The explanatory subtitle was dropped by the Editorial Ember copy rule; the
        // row is still reachable and labeled for VoiceOver.
        XCTAssertFalse(source.contains("Past conversations & invocations"))
        XCTAssertTrue(source.contains(".accessibilityIdentifier(\"relay-threads\")"))
        XCTAssertTrue(source.contains("conversations and invocations"))
        XCTAssertTrue(source.contains(".navigationTitle(\"Threads\")"))
        XCTAssertFalse(source.contains("clock.arrow.circlepath"))
        XCTAssertTrue(source.contains("@State private var fullLogRequest: RelayFullLogRequest?"))
        XCTAssertTrue(source.contains(".sheet(item: $fullLogRequest)"))
        XCTAssertTrue(source.contains("var id: String { job.id }"))
        XCTAssertFalse(source.contains("fullLogText.map(RelayFullLogText.init"))

        XCTAssertTrue(viewModelSource.contains("workspaceID: workspaceID, limit: 200"))
        XCTAssertTrue(viewModelSource.contains("belongsToHistoryScope($0.workspaceId)"))
        XCTAssertTrue(viewModelSource.contains("workspaceID: workspaceID,"))
        XCTAssertFalse(viewModelSource.contains("client.fetchThreads(provider: nil, workspaceID: nil, limit: 200)"))
    }

    func testRelayHistoryContinuationStaysInFolderWorkspace() {
        XCTAssertEqual(
            RelayChatViewModel.conversationWorkspaceID(
                currentThreadID: "thread-scratch",
                currentThreadWorkspaceID: "scratch",
                defaultWorkspaceID: "scratch"
            ),
            "scratch"
        )
        XCTAssertEqual(
            RelayChatViewModel.conversationWorkspaceID(
                currentThreadID: nil,
                currentThreadWorkspaceID: "scratch",
                defaultWorkspaceID: "scratch"
            ),
            "scratch",
            "A standalone invocation without a session must retain its folder workspace"
        )
        XCTAssertNil(
            RelayChatViewModel.conversationWorkspaceID(
                currentThreadID: "global-chat",
                currentThreadWorkspaceID: nil,
                defaultWorkspaceID: "poc-vault"
            )
        )
        XCTAssertEqual(
            RelayChatViewModel.conversationWorkspaceID(
                currentThreadID: nil,
                currentThreadWorkspaceID: nil,
                defaultWorkspaceID: "poc-vault"
            ),
            "poc-vault"
        )
    }

    func testRelayHistoryScopeMatchesOnlyTheOriginatingFolder() {
        XCTAssertTrue(RelayChatViewModel.isInHistoryScope(
            itemWorkspaceID: "dir-poc-vault-docs",
            folderWorkspaceID: "dir-poc-vault-docs",
            isWorkspaceRoot: false
        ))
        XCTAssertFalse(RelayChatViewModel.isInHistoryScope(
            itemWorkspaceID: "poc-vault",
            folderWorkspaceID: "dir-poc-vault-docs",
            isWorkspaceRoot: false
        ))
        XCTAssertFalse(RelayChatViewModel.isInHistoryScope(
            itemWorkspaceID: nil,
            folderWorkspaceID: nil,
            isWorkspaceRoot: false
        ))
        XCTAssertTrue(RelayChatViewModel.isInHistoryScope(
            itemWorkspaceID: nil,
            folderWorkspaceID: nil,
            isWorkspaceRoot: true
        ))
        XCTAssertFalse(RelayChatViewModel.isInHistoryScope(
            itemWorkspaceID: "poc-vault",
            folderWorkspaceID: nil,
            isWorkspaceRoot: true
        ))
    }

    // MARK: - Files API models + client contract (revamp I1)

    func testCodexDirectoryEntryDecodesFileMetadata() throws {
        let entry = try decodeDirectoryEntry(
            """
            {
              "name": "README.md",
              "kind": "file",
              "path": "/srv/codex-workspaces/poc-vault/README.md",
              "relativePath": "poc-vault/README.md",
              "size": 2048,
              "mtime": "2026-08-01T10:15:00Z",
              "mime": "text/markdown",
              "isText": true,
              "readDenied": false
            }
            """
        )

        XCTAssertEqual(entry.kind, .file)
        XCTAssertFalse(entry.isDirectory)
        XCTAssertEqual(entry.size, 2_048)
        XCTAssertNotNil(entry.mtime)
        XCTAssertNotNil(entry.mtimeLabel)
        XCTAssertEqual(entry.mime, "text/markdown")
        XCTAssertEqual(entry.isText, true)
        XCTAssertFalse(entry.readDenied)
        XCTAssertEqual(entry.fileCategory, .markdown)
        let sizeLabel = try XCTUnwrap(entry.sizeLabel)
        XCTAssertFalse(sizeLabel.isEmpty)
    }

    func testCodexDirectoryEntryDefaultsLegacyEntriesToDirectories() throws {
        let entry = try decodeDirectoryEntry(
            """
            {
              "name": "notes",
              "path": "/srv/codex-workspaces/notes",
              "hasGit": false,
              "isRegistered": false
            }
            """
        )

        XCTAssertEqual(entry.kind, .dir)
        XCTAssertTrue(entry.isDirectory)
        XCTAssertNil(entry.size)
        XCTAssertNil(entry.sizeLabel)
        XCTAssertNil(entry.mtime)
        XCTAssertNil(entry.mtimeLabel)
        XCTAssertNil(entry.mime)
        XCTAssertNil(entry.isText)
        XCTAssertFalse(entry.readDenied)
    }

    func testCodexDirectoryEntryDecodesReadDeniedSecretFiles() throws {
        let entry = try decodeDirectoryEntry(
            """
            {
              "name": ".env",
              "kind": "file",
              "path": "/srv/codex-workspaces/poc-vault/.env",
              "readDenied": true
            }
            """
        )

        XCTAssertEqual(entry.kind, .file)
        XCTAssertTrue(entry.readDenied)
    }

    func testCodexDirectoryListingDecodesPaginationAndTruncation() throws {
        let listing = try JSONDecoder().decode(
            CodexWorkspaceDirectoryListing.self,
            from: Data(
                """
                {
                  "rootPath": "/srv/codex-workspaces",
                  "currentPath": "/srv/codex-workspaces/poc-vault",
                  "relativePath": "poc-vault",
                  "parentPath": "/srv/codex-workspaces",
                  "offset": 0,
                  "limit": 2,
                  "total": 5,
                  "truncated": true,
                  "entries": [
                    { "name": "src", "kind": "dir", "path": "/srv/codex-workspaces/poc-vault/src" },
                    { "name": "app.js", "kind": "file", "path": "/srv/codex-workspaces/poc-vault/app.js", "size": 640 }
                  ]
                }
                """.utf8
            )
        )

        XCTAssertTrue(listing.truncated)
        XCTAssertEqual(listing.total, 5)
        XCTAssertEqual(listing.offset, 0)
        XCTAssertEqual(listing.limit, 2)
        XCTAssertEqual(listing.entries.count, 2)
        XCTAssertTrue(listing.entries[0].isDirectory)
        XCTAssertFalse(listing.entries[1].isDirectory)

        let legacyListing = try JSONDecoder().decode(
            CodexWorkspaceDirectoryListing.self,
            from: Data(
                """
                {
                  "rootPath": "/srv/codex-workspaces",
                  "currentPath": "/srv/codex-workspaces",
                  "entries": []
                }
                """.utf8
            )
        )

        XCTAssertFalse(legacyListing.truncated)
        XCTAssertNil(legacyListing.total)
        XCTAssertNil(legacyListing.offset)
        XCTAssertNil(legacyListing.limit)
    }

    func testCodexFileCategoryInfersViewerTypesFromMimeAndExtension() throws {
        func category(name: String, mime: String? = nil, isText: Bool? = nil) throws -> CodexFileCategory {
            var fields = [
                "\"name\": \"\(name)\"",
                "\"kind\": \"file\"",
                "\"path\": \"/srv/codex-workspaces/poc-vault/\(name)\""
            ]
            if let mime {
                fields.append("\"mime\": \"\(mime)\"")
            }
            if let isText {
                fields.append("\"isText\": \(isText)")
            }
            return try decodeDirectoryEntry("{\(fields.joined(separator: ", "))}").fileCategory
        }

        XCTAssertEqual(try category(name: "main.swift"), .code)
        XCTAssertEqual(try category(name: "server.mjs", mime: "text/javascript"), .code)
        XCTAssertEqual(try category(name: "photo.PNG"), .image)
        XCTAssertEqual(try category(name: "scan", mime: "image/jpeg"), .image)
        XCTAssertEqual(try category(name: "report.pdf"), .pdf)
        XCTAssertEqual(try category(name: "paper", mime: "application/pdf"), .pdf)
        XCTAssertEqual(try category(name: "README.md"), .markdown)
        XCTAssertEqual(try category(name: "readme", mime: "text/markdown"), .markdown)
        XCTAssertEqual(try category(name: "readme", mime: "text/markdown; charset=utf-8"), .markdown)
        XCTAssertEqual(try category(name: "notes.txt"), .text)
        XCTAssertEqual(try category(name: "LICENSE", isText: true), .text)
        XCTAssertEqual(try category(name: "blob.dat", mime: "application/octet-stream"), .binary)
        XCTAssertEqual(try category(name: "mystery"), .binary)
    }

    // MARK: - File viewer routing + paging (revamp I3)

    func testRelayFileViewerRoutesCategoriesToPresentationKinds() throws {
        func kind(name: String, mime: String? = nil, isText: Bool? = nil, readDenied: Bool = false) throws -> RelayFileViewerKind {
            var fields = [
                "\"name\": \"\(name)\"",
                "\"kind\": \"file\"",
                "\"path\": \"/srv/codex-workspaces/poc-vault/\(name)\""
            ]
            if let mime {
                fields.append("\"mime\": \"\(mime)\"")
            }
            if let isText {
                fields.append("\"isText\": \(isText)")
            }
            if readDenied {
                fields.append("\"readDenied\": true")
            }
            return try decodeDirectoryEntry("{\(fields.joined(separator: ", "))}").viewerKind
        }

        // Code and plain text share the monospaced text surface.
        XCTAssertEqual(try kind(name: "main.swift"), .text)
        XCTAssertEqual(try kind(name: "server.mjs", mime: "text/javascript"), .text)
        XCTAssertEqual(try kind(name: "notes.txt"), .text)
        XCTAssertEqual(try kind(name: "LICENSE", isText: true), .text)

        // Markdown renders through the shared Relay markdown views.
        XCTAssertEqual(try kind(name: "README.md"), .markdown)
        XCTAssertEqual(try kind(name: "readme", mime: "text/markdown; charset=utf-8"), .markdown)

        // Bitmaps get the fit-width image surface.
        XCTAssertEqual(try kind(name: "photo.PNG"), .image)
        XCTAssertEqual(try kind(name: "scan", mime: "image/jpeg"), .image)

        // PDF and HTML render through the authenticated web view — HTML is `.code` by
        // file category but must not fall into the mono text surface.
        XCTAssertEqual(try kind(name: "report.pdf"), .web)
        XCTAssertEqual(try kind(name: "paper", mime: "application/pdf"), .web)
        XCTAssertEqual(try kind(name: "index.html"), .web)
        XCTAssertEqual(try kind(name: "widget.htm"), .web)
        XCTAssertEqual(try kind(name: "page", mime: "text/html; charset=utf-8"), .web)

        // Unknown bytes and read-denied entries fall back to the share placeholder.
        XCTAssertEqual(try kind(name: "blob.dat", mime: "application/octet-stream"), .binary)
        XCTAssertEqual(try kind(name: "mystery"), .binary)
        XCTAssertEqual(try kind(name: ".env", isText: true, readDenied: true), .binary)
    }

    @MainActor
    func testRelayFileViewerLoadMoreRangesContinueFromLoadedBytes() throws {
        let firstRange = FileViewerViewModel.nextRange(afterLoadedByteCount: 0)
        XCTAssertEqual(firstRange.lowerBound, 0)
        XCTAssertEqual(
            firstRange.upperBound,
            FileViewerViewModel.loadMoreChunkByteCount - 1
        )

        let continuation = FileViewerViewModel.nextRange(afterLoadedByteCount: 1_048_576)
        XCTAssertEqual(continuation.lowerBound, 1_048_576)
        XCTAssertEqual(
            continuation.upperBound,
            1_048_576 + FileViewerViewModel.loadMoreChunkByteCount - 1
        )

        let smallChunk = FileViewerViewModel.nextRange(afterLoadedByteCount: 10, chunkByteCount: 4)
        XCTAssertEqual(smallChunk, 10...13)
    }

    @MainActor
    func testRelayFileViewerTruncationTracksKnownSizeAndRangeResponses() throws {
        // A known listing size is authoritative: more remains until it is reached, even
        // though every Range response reports 206.
        XCTAssertTrue(FileViewerViewModel.remainingBytesExist(
            responseTruncated: true,
            receivedByteCount: 1_048_576,
            loadedByteCount: 1_048_576,
            knownFileSize: 1_572_864
        ))
        XCTAssertFalse(FileViewerViewModel.remainingBytesExist(
            responseTruncated: true,
            requestedByteCount: 524_288,
            receivedByteCount: 524_288,
            loadedByteCount: 1_572_864,
            knownFileSize: 1_572_864
        ))

        // Without a known size, the initial fetch trusts the 206/Content-Range signal.
        XCTAssertTrue(FileViewerViewModel.remainingBytesExist(
            responseTruncated: true,
            receivedByteCount: 1_048_576,
            loadedByteCount: 1_048_576,
            knownFileSize: nil
        ))
        XCTAssertFalse(FileViewerViewModel.remainingBytesExist(
            responseTruncated: false,
            receivedByteCount: 2_048,
            loadedByteCount: 2_048,
            knownFileSize: nil
        ))

        // A short or empty Range response means EOF was reached.
        XCTAssertFalse(FileViewerViewModel.remainingBytesExist(
            responseTruncated: true,
            requestedByteCount: 524_288,
            receivedByteCount: 100,
            loadedByteCount: 1_048_676,
            knownFileSize: nil
        ))
        XCTAssertFalse(FileViewerViewModel.remainingBytesExist(
            responseTruncated: true,
            requestedByteCount: 524_288,
            receivedByteCount: 0,
            loadedByteCount: 1_048_576,
            knownFileSize: nil
        ))
    }

    @MainActor
    func testRelayFileViewerChunksMonoTextWithoutAlteringContent() throws {
        XCTAssertEqual(FileViewerViewModel.chunkedLines(""), [])
        XCTAssertEqual(FileViewerViewModel.chunkedLines("short file\n"), ["short file\n"])

        let lines = (0..<1_000).map { "line \($0)" }
        let text = lines.joined(separator: "\n")
        let chunks = FileViewerViewModel.chunkedLines(text, linesPerChunk: 400)

        // Bounded chunks so a megabyte-scale file never lands in a single SwiftUI Text,
        // and rejoining reproduces the exact loaded content.
        XCTAssertEqual(chunks.count, 3)
        XCTAssertTrue(chunks.allSatisfy { $0.split(separator: "\n", omittingEmptySubsequences: false).count <= 400 })
        XCTAssertEqual(chunks.joined(separator: "\n"), text)
    }

    @MainActor
    func testRelayFileViewerOnlyWebKindSkipsByteFetch() throws {
        func makeViewModel(_ json: String) throws -> FileViewerViewModel {
            FileViewerViewModel(
                client: makeOfflineCodexClient(),
                entry: try decodeDirectoryEntry(json)
            )
        }

        let pdf = try makeViewModel(
            """
            { "name": "report.pdf", "kind": "file", "path": "/srv/codex-workspaces/poc-vault/report.pdf" }
            """
        )
        XCTAssertEqual(pdf.kind, .web)
        XCTAssertFalse(pdf.needsByteFetch)

        let markdown = try makeViewModel(
            """
            { "name": "readme.md", "kind": "file", "path": "/srv/codex-workspaces/poc-vault/readme.md", "size": 4096 }
            """
        )
        XCTAssertEqual(markdown.kind, .markdown)
        XCTAssertTrue(markdown.needsByteFetch)
        XCTAssertEqual(markdown.truncationLabel.contains("of"), true)

        let unsizedLog = try makeViewModel(
            """
            { "name": "build.log", "kind": "file", "path": "/srv/codex-workspaces/poc-vault/build.log" }
            """
        )
        XCTAssertEqual(unsizedLog.kind, .text)
        XCTAssertTrue(unsizedLog.truncationLabel.contains("first"))
    }

    func testCodexClientBuildsWebViewURLForJailFiles() throws {
        let client = CodexClient(
            baseURL: URL(string: "http://127.0.0.1:8787")!,
            identityStore: ClientIdentityStore()
        )
        let url = try XCTUnwrap(client.fileWebViewURL(path: "poc-vault/docs/report.pdf"))
        XCTAssertEqual(url.scheme, "http")
        XCTAssertEqual(url.path, "/v1/codex/fs/file")
        XCTAssertEqual(
            URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "path" })?.value,
            "poc-vault/docs/report.pdf"
        )
    }

    func testCodexProviderCursorDecodingRoundTrips() throws {
        let models = try decodeCodexModels(
            """
            [
              { "id": "cursor-auto", "label": "Cursor Agent · Auto", "provider": "cursor", "modes": ["task"] },
              { "id": "cursor-agent-auto", "label": "Cursor Agent", "provider": "cursor-agent", "modes": ["task"] }
            ]
            """
        )

        XCTAssertEqual(models.count, 2)
        XCTAssertEqual(models[0].provider, .cursor)
        XCTAssertEqual(models[1].provider, .cursor)
        XCTAssertTrue(models[0].supports(.task))
        XCTAssertFalse(models[0].supports(.chat))
        XCTAssertEqual(CodexProvider(rawProvider: "cursor-agent"), .cursor)

        let encoded = try JSONEncoder().encode(CodexProvider.cursor)
        XCTAssertEqual(String(data: encoded, encoding: .utf8), "\"cursor\"")
    }

    func testRelayModelChoiceKeepsDualModeIdentitiesDistinct() throws {
        let models = try decodeCodexModels(
            """
            [
              { "id": "gpt-5.6-sol", "label": "Codex · GPT-5.6 Sol", "provider": "codex", "modes": ["chat", "task"] }
            ]
            """
        )
        let model = try XCTUnwrap(models.first)

        let chatChoice = RelayModelChoice(model: model, mode: .chat)
        let taskChoice = RelayModelChoice(model: model, mode: .task)

        XCTAssertNotEqual(chatChoice.id, taskChoice.id)
        XCTAssertNotEqual(chatChoice, taskChoice)
        XCTAssertTrue(chatChoice.id.contains("gpt-5.6-sol"))
        XCTAssertTrue(taskChoice.id.contains("gpt-5.6-sol"))
        XCTAssertEqual(chatChoice, RelayModelChoice(model: model, mode: .chat))
        XCTAssertEqual(Set([chatChoice, taskChoice]).count, 2)
    }

    func testCodexJobStreamEventDecodesRawSSEDataLines() throws {
        var parser = CodexSSELineParser<CodexJobStreamEvent> { event, data in
            CodexJobStreamEvent.decode(event: event, data: data)
        }
        var events: [CodexJobStreamEvent] = []

        events.append(contentsOf: parser.ingest("event: status"))
        events.append(contentsOf: parser.ingest("data: {\"id\":\"job-9\",\"status\":\"running\"}"))
        events.append(contentsOf: parser.ingest(""))
        events.append(contentsOf: parser.ingest("event: stdout"))
        events.append(contentsOf: parser.ingest("data: {\"offset\":0,\"text\":\"building\\n\"}"))
        events.append(contentsOf: parser.ingest(""))
        events.append(contentsOf: parser.ingest("event: heartbeat"))
        events.append(contentsOf: parser.ingest("data: {}"))
        events.append(contentsOf: parser.ingest(""))
        events.append(contentsOf: parser.ingest("event: stderr"))
        events.append(contentsOf: parser.ingest("data: {\"offset\":12,\"text\":\"warning\"}"))
        events.append(contentsOf: parser.ingest(""))
        events.append(contentsOf: parser.ingest("event: done"))
        events.append(contentsOf: parser.ingest("data: {\"id\":\"job-9\",\"status\":\"succeeded\",\"result\":\"All done.\"}"))
        events.append(contentsOf: parser.finish())

        XCTAssertEqual(events.count, 4)

        guard case .status(let statusJob) = events[0] else {
            return XCTFail("Expected a status event, got \(events[0])")
        }
        XCTAssertEqual(statusJob.id, "job-9")
        XCTAssertEqual(statusJob.status, .running)

        XCTAssertEqual(events[1], .stdout(offset: 0, text: "building\n"))
        XCTAssertEqual(events[2], .stderr(offset: 12, text: "warning"))

        guard case .done(let doneJob) = events[3] else {
            return XCTFail("Expected a done event, got \(events[3])")
        }
        XCTAssertEqual(doneJob.id, "job-9")
        XCTAssertEqual(doneJob.status, .succeeded)
        XCTAssertEqual(doneJob.result, "All done.")
    }

    func testModelCatalogDecodingNeverSurfacesProviderCredentials() throws {
        let models = try decodeCodexModels(
            """
            [
              {
                "id": "azure-prod/gpt-5.5",
                "label": "gpt-5.5 (Azure Prod)",
                "provider": "azure",
                "modes": ["chat"],
                "azureDeployment": "gpt-5.5",
                "azureBaseURL": "https://example.openai.azure.com/openai/v1",
                "azureApiKeyFile": "/etc/codex-api/azure/prod.key",
                "apiKey": "sk-should-never-surface",
                "authToken": "should-never-surface"
              }
            ]
            """
        )
        let model = try XCTUnwrap(models.first)

        XCTAssertEqual(model.provider, .azure)
        XCTAssertEqual(model.azureDeployment, "gpt-5.5")

        // No credential-shaped stored property may exist on the client model...
        let credentialMarkers = ["key", "secret", "token", "credential", "password"]
        for label in Mirror(reflecting: model).children.compactMap(\.label) {
            let lowered = label.lowercased()
            for marker in credentialMarkers {
                XCTAssertFalse(lowered.contains(marker), "Credential-shaped field decoded from /models: \(label)")
            }
        }

        // ...and none of the injected credential material may be retained anywhere.
        let dump = String(describing: model)
        XCTAssertFalse(dump.contains("sk-should-never-surface"))
        XCTAssertFalse(dump.contains("should-never-surface"))
        XCTAssertFalse(dump.contains("prod.key"))
        XCTAssertFalse(dump.contains("azureBaseURL"))
    }

    func testConfiguredURLTreatsPlaceholdersAsUnset() throws {
        // The checked-in *.example.com build-setting defaults and un-expanded $(VAR)
        // tokens must both lose to the in-code fallback — otherwise a default
        // xcodebuild simulator install points at a dead host instead of the fixture.
        XCTAssertEqual(
            AppConfiguration.resolveConfiguredURL(
                candidates: [nil, "https://codex.pocs.example.com"],
                fallback: "http://127.0.0.1:8787"
            ),
            URL(string: "http://127.0.0.1:8787")
        )
        XCTAssertEqual(
            AppConfiguration.resolveConfiguredURL(
                candidates: ["$(POC_VAULT_CODEX_BASE_URL)", ""],
                fallback: "http://127.0.0.1:8787"
            ),
            URL(string: "http://127.0.0.1:8787")
        )
        XCTAssertFalse(AppConfiguration.isConfiguredURLValue("https://vault.pocs.example.com/manifest.json"))
        XCTAssertFalse(AppConfiguration.isConfiguredURLValue("https://example.com"))
        XCTAssertFalse(AppConfiguration.isConfiguredURLValue(""))
        XCTAssertFalse(AppConfiguration.isConfiguredURLValue("$(POC_VAULT_MANIFEST_URL)"))
    }

    func testConfiguredURLKeepsInjectionSeamForRealBuilds() throws {
        // An owner-injected live URL still beats the fallback (device-build seam) …
        XCTAssertEqual(
            AppConfiguration.resolveConfiguredURL(
                candidates: [nil, "http://127.0.0.1:8899"],
                fallback: "http://127.0.0.1:8787"
            ),
            URL(string: "http://127.0.0.1:8899")
        )
        // … and the support-config value outranks the Info.plist value.
        XCTAssertEqual(
            AppConfiguration.resolveConfiguredURL(
                candidates: ["https://relay.internal.test", "https://codex.pocs.example.com"],
                fallback: "http://127.0.0.1:8787"
            ),
            URL(string: "https://relay.internal.test")
        )
        XCTAssertTrue(AppConfiguration.isConfiguredURLValue("https://relay.internal.test"))
    }

    private func decodeDirectoryEntry(_ json: String) throws -> CodexWorkspaceDirectoryEntry {
        try JSONDecoder().decode(CodexWorkspaceDirectoryEntry.self, from: Data(json.utf8))
    }

    private func decodeCodexJob(_ json: String) throws -> CodexJob {
        try JSONDecoder().decode(CodexJob.self, from: Data(json.utf8))
    }

    private func decodeCodexThread(_ json: String) throws -> CodexThread {
        try JSONDecoder().decode(CodexThread.self, from: Data(json.utf8))
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

    private func decodeCodexModels(_ json: String) throws -> [CodexModelDescriptor] {
        try JSONDecoder().decode([CodexModelDescriptor].self, from: Data(json.utf8))
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

/// Loads app sources for design-rule tests that grep Swift files on disk.
///
/// Locally, `#filePath` next to `POCVaultTests/` resolves into the project tree.
/// On Xcode Cloud the clone path is often unavailable to the test runner even when
/// `#filePath` points at `/Volumes/workspace/repository/...`, which is why TestFlight
/// was failing with NSCocoaErrorDomain 260 — not because those files were deleted.
/// Try the usual relatives, then CI env roots; skip instead of failing the ship build.
enum AppSourceFixture {
    static func load(
        _ relativeUnderProject: String,
        probeFile: String = #filePath
    ) throws -> String {
        var candidates: [String] = [
            URL(fileURLWithPath: probeFile)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent(relativeUnderProject)
                .path
        ]

        if let repo = ProcessInfo.processInfo.environment["CI_PRIMARY_REPOSITORY_PATH"], !repo.isEmpty {
            candidates.append(
                URL(fileURLWithPath: repo)
                    .appendingPathComponent("ios/POCVault")
                    .appendingPathComponent(relativeUnderProject)
                    .path
            )
        }
        if let srcRoot = ProcessInfo.processInfo.environment["SRCROOT"], !srcRoot.isEmpty {
            candidates.append(
                URL(fileURLWithPath: srcRoot)
                    .appendingPathComponent(relativeUnderProject)
                    .path
            )
        }

        for path in candidates where FileManager.default.isReadableFile(atPath: path) {
            return try String(contentsOfFile: path, encoding: .utf8)
        }

        throw XCTSkip(
            "App source unavailable (\(relativeUnderProject)); skipped when the checkout is not readable at test runtime"
        )
    }
}
