import SwiftUI
import XCTest
@testable import POCVault

// Composer tests. Owned by the composer lane.

final class RelayComposerTests: XCTestCase {
    private static let catalogJSON = """
    [
      {"id":"claude-default","label":"Claude Code","provider":"claude","modes":["task"]},
      {"id":"claude-opus","label":"Claude Opus 5.5","provider":"claude","modes":["task"],"taskModel":"opus"},
      {"id":"claude-sonnet","label":"Claude Sonnet 5.5","provider":"claude","modes":["task"],"taskModel":"sonnet"},
      {"id":"gpt-5.5","label":"GPT-5.5","provider":"codex","modes":["chat","task"],"taskModel":"gpt-5.5"},
      {"id":"cursor-composer","label":"Composer","provider":"cursor","modes":["task"]}
    ]
    """

    /// Codex, Claude Code, Cursor, Kimi and a chat model: five tabs.
    private static let fiveAgentJSON = """
    [
      {"id":"codex-default","label":"Codex","provider":"codex","modes":["task"]},
      {"id":"gpt-5.6-sol","label":"GPT-5.6 Sol","provider":"codex","modes":["chat","task"],"taskModel":"gpt-5.6-sol"},
      {"id":"gpt-5.6-terra","label":"GPT-5.6 Terra","provider":"codex","modes":["chat","task"],"taskModel":"gpt-5.6-terra"},
      {"id":"claude-default","label":"Claude Code","provider":"claude","modes":["task"]},
      {"id":"claude-opus","label":"Claude Opus 5.5","provider":"claude","modes":["task"],"taskModel":"opus"},
      {"id":"cursor-composer","label":"Composer","provider":"cursor","modes":["task"]},
      {"id":"kimi-k3","label":"Kimi K3","provider":"kimi","modes":["task"],"taskModel":"k3"}
    ]
    """

    /// Three harnesses and no chat models: the approved single row of pills.
    private static let threeAgentJSON = """
    [
      {"id":"codex-default","label":"Codex","provider":"codex","modes":["task"]},
      {"id":"claude-default","label":"Claude Code","provider":"claude","modes":["task"]},
      {"id":"claude-opus","label":"Claude Opus 5.5","provider":"claude","modes":["task"],"taskModel":"opus"},
      {"id":"cursor-composer","label":"Composer","provider":"cursor","modes":["task"]}
    ]
    """

    private func sections(_ json: String = RelayComposerTests.catalogJSON) throws -> RelayModelPickerSections {
        let models = try JSONDecoder().decode([CodexModelDescriptor].self, from: Data(json.utf8))
        return RelayModelDiscovery.sections(from: models)
    }

    private func choice(
        _ id: String,
        in sections: RelayModelPickerSections,
        mode: RelayInteractionMode = .task
    ) throws -> RelayModelChoice {
        try XCTUnwrap(sections.allChoices.first { $0.model.id == id && $0.mode == mode })
    }

    // MARK: Pill

    func testEffortLabelFollowsSelectionAndHidesWithoutEfforts() {
        XCTAssertNil(RelayComposerLogic.effortLabel(efforts: [], selected: nil))
        XCTAssertNil(RelayComposerLogic.effortLabel(efforts: [], selected: .high))
        XCTAssertEqual(RelayComposerLogic.effortLabel(efforts: [.low, .high], selected: .high), "High")
        // Nothing chosen yet: the first advertised level is what the job will use.
        XCTAssertEqual(RelayComposerLogic.effortLabel(efforts: [.medium, .high], selected: nil), "Medium")
    }

    func testPillAccessibilityLabelNamesModelAndEffort() {
        XCTAssertEqual(RelayComposerLogic.pillAccessibilityLabel(model: nil, effort: "High"), "Choose model")
        XCTAssertEqual(RelayComposerLogic.pillAccessibilityLabel(model: "Opus 5.5", effort: nil), "Model Opus 5.5")
        XCTAssertEqual(
            RelayComposerLogic.pillAccessibilityLabel(model: "Opus 5.5", effort: "High"),
            "Model Opus 5.5, effort High"
        )
    }

    // MARK: Model sheet

    func testModelSheetHasOneTabPerHarnessPlusChat() throws {
        let sections = try sections()
        XCTAssertEqual(
            RelayModelSheetTab.tabs(for: sections),
            sections.agents.map { .agent($0.provider) } + [.chat]
        )
        XCTAssertEqual(Set(sections.agents.map(\.provider)), [.codex, .claude, .cursor])

        let agentsOnly = RelayModelPickerSections(agents: sections.agents, chatModels: [])
        XCTAssertFalse(RelayModelSheetTab.tabs(for: agentsOnly).contains(.chat))
        XCTAssertTrue(RelayModelSheetTab.tabs(for: RelayModelPickerSections(agents: [], chatModels: [])).isEmpty)
    }

    func testModelSheetStartsOnTheTabThatOwnsTheSelection() throws {
        let sections = try sections()
        let opus = try choice("claude-opus", in: sections)
        let codexTask = try choice("gpt-5.5", in: sections)
        let codexChat = try choice("gpt-5.5", in: sections, mode: .chat)

        XCTAssertEqual(RelayModelSheetTab.initial(for: sections, selectedChoice: opus), .agent(.claude))
        XCTAssertEqual(RelayModelSheetTab.initial(for: sections, selectedChoice: codexTask), .agent(.codex))
        XCTAssertEqual(RelayModelSheetTab.initial(for: sections, selectedChoice: codexChat), .chat)
        // Nothing selected, or a selection the catalog no longer has: first tab.
        XCTAssertEqual(
            RelayModelSheetTab.initial(for: sections, selectedChoice: nil),
            RelayModelSheetTab.tabs(for: sections).first
        )
        let claudeOnly = sections.restricted(to: .claude)
        XCTAssertEqual(RelayModelSheetTab.initial(for: claudeOnly, selectedChoice: codexTask), .agent(.claude))
        XCTAssertNil(RelayModelSheetTab.initial(
            for: RelayModelPickerSections(agents: [], chatModels: []),
            selectedChoice: nil
        ))
    }

    func testModelSheetTabListsOnlyItsOwnChoices() throws {
        let sections = try sections()
        let claude = RelayModelSheetTab.agent(.claude).choices(in: sections)
        XCTAssertEqual(claude.map(\.model.id), ["claude-default", "claude-opus", "claude-sonnet"])
        XCTAssertTrue(claude.allSatisfy { $0.executionProvider == .claude })
        XCTAssertEqual(RelayModelSheetTab.chat.choices(in: sections), sections.chatModels)
        XCTAssertTrue(RelayModelSheetTab.agent(.kimi).choices(in: sections).isEmpty)

        let opus = try choice("claude-opus", in: sections)
        XCTAssertEqual(RelayModelSheetTab.agent(.claude).rowTitle(for: opus), opus.shortModelLabel)
        let chat = try choice("gpt-5.5", in: sections, mode: .chat)
        XCTAssertEqual(RelayModelSheetTab.chat.rowTitle(for: chat), chat.chipLabel)
        XCTAssertEqual(RelayModelSheetTab.agent(.claude).title, "Claude Code")
        XCTAssertEqual(RelayModelSheetTab.chat.title, "Chat")
    }

    func testFiveAndThreeAgentCatalogsProduceTheExpectedTabs() throws {
        let five = try sections(Self.fiveAgentJSON)
        XCTAssertEqual(
            RelayModelSheetTab.tabs(for: five),
            [.agent(.codex), .agent(.claude), .agent(.cursor), .agent(.kimi), .chat]
        )
        XCTAssertEqual(
            RelayModelSheetTab.tabs(for: five).map(\.title),
            ["Codex", "Claude Code", "Cursor", RelayModelChoice.harnessTitle(for: .kimi), "Chat"]
        )
        let three = try sections(Self.threeAgentJSON)
        XCTAssertEqual(
            RelayModelSheetTab.tabs(for: three),
            [.agent(.codex), .agent(.claude), .agent(.cursor)]
        )
    }

    func testEffortRowShowsOnlyOnTheTabThatOwnsTheSelection() throws {
        let five = try sections(Self.fiveAgentJSON)
        let sol = try choice("gpt-5.6-sol", in: five)
        let solChat = try choice("gpt-5.6-sol", in: five, mode: .chat)
        func shows(_ tab: RelayModelSheetTab?, _ selected: RelayModelChoice?, thread: CodexProvider? = nil) -> Bool {
            RelayModelSheetTab.showsEffort(
                visibleTab: tab,
                sections: five.restricted(to: thread),
                selectedChoice: selected,
                threadProvider: thread
            )
        }
        XCTAssertEqual(RelayModelSheetTab.owner(of: sol, in: five), .agent(.codex))
        XCTAssertEqual(RelayModelSheetTab.owner(of: solChat, in: five), .chat)
        XCTAssertNil(RelayModelSheetTab.owner(of: nil, in: five))
        XCTAssertNil(RelayModelSheetTab.owner(of: sol, in: five.restricted(to: .claude)))

        XCTAssertTrue(shows(.agent(.codex), sol))
        // Browsing another agent's list: that list has no say over Codex's effort.
        XCTAssertFalse(shows(.agent(.claude), sol))
        XCTAssertFalse(shows(.chat, sol))
        XCTAssertTrue(shows(.chat, solChat))
        XCTAssertFalse(shows(.agent(.codex), solChat))
        XCTAssertFalse(shows(.agent(.codex), nil))
        XCTAssertFalse(shows(nil, sol))
        // A thread shows only its own harness, so the row always applies.
        XCTAssertTrue(shows(.agent(.codex), sol, thread: .codex))
    }

    func testChipsWrapInsteadOfRunningPastTheEdge() {
        let chip = CGSize(width: 100, height: 30)
        let flow = RelayComposerLogic.flowFrames(
            sizes: [chip, chip, chip, CGSize(width: 400, height: 30)],
            maxWidth: 250,
            spacing: 10,
            lineSpacing: 6
        )
        XCTAssertEqual(flow.frames, [
            CGRect(x: 0, y: 0, width: 100, height: 30),
            CGRect(x: 110, y: 0, width: 100, height: 30),
            CGRect(x: 0, y: 36, width: 100, height: 30),
            // Wider than the row: clamped to it, on a line of its own.
            CGRect(x: 0, y: 72, width: 250, height: 30)
        ])
        XCTAssertEqual(flow.size, CGSize(width: 250, height: 102))
        XCTAssertTrue(flow.frames.allSatisfy { $0.maxX <= 250 })

        let empty = RelayComposerLogic.flowFrames(sizes: [], maxWidth: 250, spacing: 10, lineSpacing: 6)
        XCTAssertTrue(empty.frames.isEmpty)
        XCTAssertEqual(empty.size, .zero)
        // Exactly filling the row does not wrap.
        let exact = RelayComposerLogic.flowFrames(
            sizes: [CGSize(width: 120, height: 20), CGSize(width: 120, height: 20)],
            maxWidth: 250, spacing: 10, lineSpacing: 6
        )
        XCTAssertEqual(exact.size, CGSize(width: 250, height: 20))
    }

    // MARK: Add sheet

    func testAddSheetRowsFollowTheProvider() {
        XCTAssertEqual(RelayComposerLogic.addRows(for: nil), [])
        XCTAssertEqual(RelayComposerLogic.addRows(for: .claude), [.permissions, .skills])
        XCTAssertEqual(RelayComposerLogic.addRows(for: .codex), [.fileAccess, .approvals, .skills])
        for provider in CodexProvider.allCases where !provider.hasTaskPermissionControls {
            XCTAssertEqual(RelayComposerLogic.addRows(for: provider), [.skills], "\(provider)")
        }
    }

    func testPermissionsCommandLandsOnTheMatchingPage() {
        XCTAssertEqual(RelayComposerLogic.permissionsStartPage(for: .claude), .permissions)
        // Two pages for Codex, so the list that shows both.
        XCTAssertEqual(RelayComposerLogic.permissionsStartPage(for: .codex), .root)
        XCTAssertEqual(RelayComposerLogic.permissionsStartPage(for: nil), .root)
    }

    func testSkillsValueLabel() {
        XCTAssertEqual(RelayComposerLogic.skillsValueLabel(selectedCount: 0), "None")
        XCTAssertEqual(RelayComposerLogic.skillsValueLabel(selectedCount: 1), "1 on")
        XCTAssertEqual(RelayComposerLogic.skillsValueLabel(selectedCount: 3), "3 on")
    }

    func testSheetHeightFollowsContentUpToSeventyPercent() {
        XCTAssertEqual(RelayComposerLogic.sheetHeight(content: 300, screen: 874), 300)
        XCTAssertEqual(RelayComposerLogic.sheetHeight(content: 300.2, screen: 874), 301)
        XCTAssertEqual(RelayComposerLogic.sheetHeight(content: 2000, screen: 874), 612)
        // Not measured yet: a sane first frame, never zero.
        XCTAssertEqual(RelayComposerLogic.sheetHeight(content: 0, screen: 874), 360)
        XCTAssertEqual(RelayComposerLogic.sheetHeight(content: 0, screen: 400), 280)
    }

    // MARK: Send and dictation

    func testCanSendRules() {
        func can(_ text: String, attachments: Bool = false, sending: Bool = false,
                 listening: Bool = false, ready: Bool = true) -> Bool {
            RelayComposerLogic.canSend(
                text: text, hasAttachments: attachments, isSending: sending,
                isListening: listening, providerReady: ready
            )
        }
        XCTAssertTrue(can("hello"))
        XCTAssertFalse(can("   \n"))
        XCTAssertTrue(can("", attachments: true))
        XCTAssertFalse(can("hello", sending: true))
        XCTAssertFalse(can("hello", listening: true))
        XCTAssertFalse(can("hello", ready: false))
    }

    func testSendAfterDictationNeedsWordsAndNoCancel() {
        func should(_ text: String, sending: Bool = false, ready: Bool = true, wanted: Bool = true) -> Bool {
            RelayComposerLogic.shouldSendAfterDictation(
                text: text, hasAttachments: false, isSending: sending,
                providerReady: ready, stillWanted: wanted
            )
        }
        XCTAssertTrue(should("Add a test so the copy cannot drift"))
        // Nothing was heard: no empty message.
        XCTAssertFalse(should(""))
        XCTAssertFalse(should("  "))
        // Cancelled while the tail was arriving.
        XCTAssertFalse(should("words", wanted: false))
        XCTAssertFalse(should("words", sending: true))
        XCTAssertFalse(should("words", ready: false))
    }

    func testDictatedTextAppendsToTheDraftThatWasThere() {
        XCTAssertNil(RelayComposerLogic.dictatedText(prefix: "draft", transcript: "  "))
        XCTAssertEqual(RelayComposerLogic.dictatedText(prefix: "", transcript: " carry on "), "carry on")
        XCTAssertEqual(
            RelayComposerLogic.dictatedText(prefix: "Fix the copy. ", transcript: "Then push it"),
            "Fix the copy.\n\nThen push it"
        )
    }

    func testWaveformHistoryIsPaddedFromTheLeadingEdge() {
        XCTAssertEqual(RelayComposerLogic.paddedLevels([0.5, 1], count: 4), [0, 0, 0.5, 1])
        XCTAssertEqual(RelayComposerLogic.paddedLevels([0.1, 0.2, 0.3], count: 2), [0.2, 0.3])
        XCTAssertEqual(RelayComposerLogic.paddedLevels([], count: 3), [0, 0, 0])
        XCTAssertEqual(RelayComposerLogic.paddedLevels([1], count: 0), [])
    }

    // MARK: Rendered snapshots (opt-in)

    /// Renders the composer and each sheet page to PNG for a human to look at. Runs
    /// only when RELAY_COMPOSER_SNAPSHOT_DIR is set
    /// (`TEST_RUNNER_RELAY_COMPOSER_SNAPSHOT_DIR=<dir> xcodebuild test ...`).
    @MainActor
    func testRenderComposerSnapshots() throws {
        guard let directory = ProcessInfo.processInfo.environment["RELAY_COMPOSER_SNAPSHOT_DIR"],
              !directory.isEmpty else {
            throw XCTSkip("Set RELAY_COMPOSER_SNAPSHOT_DIR to render composer snapshots")
        }
        let output = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

        let sections = try sections()
        let opus = try choice("claude-opus", in: sections)
        let codex = try choice("gpt-5.5", in: sections)
        let efforts: [CodexReasoningEffort] = [.low, .medium, .high, .xhigh, .max]
        let skills = try JSONDecoder().decode([CodexSkillDescriptor].self, from: Data("""
        [
          {"id":"s1","name":"code-review","title":"Code review","provider":"claude","group":"user","description":"Review the current diff for correctness bugs."},
          {"id":"s2","name":"deploy","title":"Deploy","provider":"claude","group":"project","description":"Ship the backend through the pipeline."}
        ]
        """.utf8))

        func composer(_ text: String, streaming: Bool = false, skillIDs: Set<String> = []) -> some View {
            ZStack(alignment: .bottom) {
                AppTheme.bgCanvas
                Text(String(repeating: "The idle auto-stop now needs both signals quiet for an hour. ", count: 12))
                    .font(RelayChatStyle.bodyFont)
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(.horizontal, 16)
                RelayComposerPreviewHost(
                    text: text,
                    sections: sections,
                    selectedChoice: opus,
                    efforts: efforts,
                    selectedEffort: .high,
                    skills: skills,
                    selectedSkillIDs: skillIDs,
                    isStreaming: streaming
                )
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        try render(composer(""), size: CGSize(width: 402, height: 300), to: output, name: "composer-idle")
        try render(composer("Fix the copy and push it."), size: CGSize(width: 402, height: 300), to: output, name: "composer-draft")
        try render(composer("", streaming: true, skillIDs: ["s1"]), size: CGSize(width: 402, height: 300), to: output, name: "composer-streaming-skill")
        try render(composer(""), size: CGSize(width: 320, height: 300), to: output, name: "composer-narrow")
        let manySkills = try JSONDecoder().decode([CodexSkillDescriptor].self, from: Data("""
        [
          {"id":"m1","name":"code-review","title":"a","provider":"claude","group":"g","description":""},
          {"id":"m2","name":"anthropic-skills:consolidate-memory","title":"b","provider":"claude","group":"g","description":""},
          {"id":"m3","name":"deploy","title":"c","provider":"claude","group":"g","description":""},
          {"id":"m4","name":"dev-desktop-handoff","title":"d","provider":"claude","group":"g","description":""},
          {"id":"m5","name":"a-skill-with-a-name-far-too-long-to-fit-on-one-line-of-any-phone","title":"e","provider":"claude","group":"g","description":""}
        ]
        """.utf8))
        try render(
            ZStack(alignment: .bottom) {
                AppTheme.bgCanvas
                RelayComposerPreviewHost(
                    text: "",
                    sections: sections,
                    selectedChoice: opus,
                    efforts: efforts,
                    selectedEffort: .high,
                    skills: manySkills,
                    selectedSkillIDs: Set(manySkills.map(\.id))
                )
                .fixedSize(horizontal: false, vertical: true)
            },
            size: CGSize(width: 402, height: 340), to: output, name: "composer-skills-wrap"
        )

        func dictation(finalizing: Bool) -> some View {
            HStack(spacing: 0) {
                RelayDictationControls(
                    levels: (0..<60).map { 0.15 + 0.8 * abs(sin(Double($0) * 0.7)) },
                    elapsed: 7,
                    finalizing: finalizing,
                    onCancel: {},
                    onStop: {}
                )
                Circle().fill(AppTheme.accent).frame(width: 36, height: 36).frame(width: 44, height: 44)
            }
            .padding(6)
            .background(RelayComposerPalette.raisedCard)
            .padding(.horizontal, 12)
            .frame(maxHeight: .infinity)
            .background(AppTheme.bgCanvas)
        }
        try render(dictation(finalizing: false), size: CGSize(width: 402, height: 80), to: output, name: "dictation-listening")
        try render(dictation(finalizing: true), size: CGSize(width: 402, height: 80), to: output, name: "dictation-transcribing")
        try render(dictation(finalizing: false), size: CGSize(width: 320, height: 80), to: output, name: "dictation-narrow")

        func modelSheet(thread: CodexProvider?, page: RelayModelSheetPage = .model) -> some View {
            RelayModelSheet(
                visibleSections: sections.restricted(to: thread),
                selectedChoice: opus,
                threadProvider: thread,
                efforts: efforts,
                selectedEffort: .high,
                onPickChoice: { _ in },
                onPickEffort: { _ in },
                onClose: {},
                startPage: page
            )
            .background(RelayComposerPalette.sheetGround)
        }
        let sheet = CGSize(width: 402, height: 560)

        // Agent tabs: five do not fit one row and become a grid; three stay pills.
        let five = try self.sections(Self.fiveAgentJSON)
        let three = try self.sections(Self.threeAgentJSON)
        let sol = try choice("gpt-5.6-sol", in: five)
        func agentSheet(
            _ catalog: RelayModelPickerSections,
            selected: RelayModelChoice,
            tab: RelayModelSheetTab? = nil
        ) -> some View {
            RelayModelSheet(
                visibleSections: catalog,
                selectedChoice: selected,
                threadProvider: nil,
                efforts: efforts,
                selectedEffort: .high,
                onPickChoice: { _ in },
                onPickEffort: { _ in },
                onClose: {},
                startTab: tab
            )
            .background(RelayComposerPalette.sheetGround)
        }
        try render(agentSheet(five, selected: sol), size: sheet, to: output, name: "sheet-model-five-agents")
        try render(agentSheet(five, selected: sol, tab: .agent(.claude)), size: sheet, to: output, name: "sheet-model-five-other-tab")
        try render(agentSheet(five, selected: sol, tab: .chat), size: CGSize(width: 320, height: 560), to: output, name: "sheet-model-five-narrow")
        try render(
            agentSheet(three, selected: try choice("claude-opus", in: three)),
            size: sheet, to: output, name: "sheet-model-three-agents"
        )
        try render(modelSheet(thread: nil), size: sheet, to: output, name: "sheet-model-new")
        try render(modelSheet(thread: .claude), size: sheet, to: output, name: "sheet-model-thread")
        try render(modelSheet(thread: .claude, page: .effort), size: sheet, to: output, name: "sheet-effort")

        func addSheet(_ page: RelayAddSheetPage, provider: CodexProvider, sandbox: RelayCodexSandbox = .workspace) -> some View {
            RelayAddSheet(
                startPage: page,
                provider: provider,
                cameraAvailable: true,
                attachDisabled: false,
                claudePermissionMode: .acceptEdits,
                codexApprovalPolicy: .onRequest,
                codexSandbox: sandbox,
                skills: skills,
                selectedSkillIDs: ["s1"],
                onPickSource: { _ in },
                onPickClaudePermission: { _ in },
                onPickCodexApproval: { _ in },
                onPickCodexSandbox: { _ in },
                onToggleSkill: { _ in },
                onClose: {}
            )
            .background(RelayComposerPalette.sheetGround)
        }
        try render(addSheet(.root, provider: .claude), size: sheet, to: output, name: "sheet-add-claude")
        try render(addSheet(.root, provider: codex.executionProvider), size: sheet, to: output, name: "sheet-add-codex")
        try render(addSheet(.permissions, provider: .claude), size: sheet, to: output, name: "sheet-permissions")
        try render(addSheet(.fileAccess, provider: .codex, sandbox: .fullAccess), size: sheet, to: output, name: "sheet-file-access-unsandboxed")
        try render(addSheet(.approvals, provider: .codex), size: sheet, to: output, name: "sheet-approvals")
        try render(addSheet(.skills, provider: .claude), size: sheet, to: output, name: "sheet-skills")

        // The same sheets really presented, to check the fitted detent, the drag
        // indicator and the bottom inset rather than only the content.
        let screen = CGSize(width: 402, height: 874)
        func presented<Sheet: View>(_ content: Sheet) -> some View {
            AppTheme.bgCanvas
                .ignoresSafeArea()
                .sheet(isPresented: .constant(true)) { content }
        }
        try render(presented(modelSheet(thread: nil)), size: screen, to: output, name: "presented-model-new", settle: 1.5)
        try render(presented(agentSheet(five, selected: sol)), size: screen, to: output, name: "presented-model-five", settle: 1.5)
        try render(presented(agentSheet(three, selected: try choice("claude-opus", in: three))), size: screen, to: output, name: "presented-model-three", settle: 1.5)
        try render(presented(modelSheet(thread: .claude, page: .effort)), size: screen, to: output, name: "presented-effort", settle: 1.5)
        try render(presented(addSheet(.root, provider: .claude)), size: screen, to: output, name: "presented-add", settle: 1.5)
        try render(presented(addSheet(.skills, provider: .claude)), size: screen, to: output, name: "presented-skills", settle: 1.5)
    }

    @MainActor
    private func render<Content: View>(
        _ view: Content,
        size: CGSize,
        to directory: URL,
        name: String,
        settle: TimeInterval = 0.4
    ) throws {
        let host = UIHostingController(rootView: view.environment(\.colorScheme, .dark))
        host.overrideUserInterfaceStyle = .dark
        host.safeAreaRegions = []
        // drawHierarchy renders black unless the window belongs to a live scene.
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "Snapshots need the test host app's window scene"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.windowLevel = .alert + 1
        window.rootViewController = host
        window.isHidden = false
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        // Preference-driven sizing and asset images settle over a couple of passes.
        RunLoop.main.run(until: Date().addingTimeInterval(settle))
        host.view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat()
        format.scale = 3
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        if host.presentedViewController != nil {
            host.dismiss(animated: false)
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        }
        window.isHidden = true
        window.rootViewController = nil
        window.windowScene = nil
        let data = try XCTUnwrap(image.pngData())
        try data.write(to: directory.appendingPathComponent("\(name).png"))
    }
}
