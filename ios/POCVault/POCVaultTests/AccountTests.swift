import Network
import SwiftUI
import UIKit
import XCTest
@testable import POCVault

final class AccountTests: XCTestCase {
    func testStoreKitAppAccountTokenMatchesServerDerivation() {
        XCTAssertEqual(
            RelaySubscriptionStore.appAccountToken(accountID: "account-a").uuidString.lowercased(),
            "332798da-332f-436e-a13a-c1d2f176bb7e"
        )
    }

    func testRelayAccountPrefersDisplayUsernameAndDetectsPasswordAccounts() {
        let user = RelayAccountUser(
            id: "user-1",
            name: "Relay User",
            email: "relay@example.com",
            username: "relay_user",
            displayUsername: "Relay User",
            image: nil
        )

        XCTAssertEqual(user.preferredName, "Relay User")
        XCTAssertTrue(user.usesPassword)
    }

    func testAppleAccountDoesNotRequireDeletionPassword() {
        let user = RelayAccountUser(
            id: "user-2",
            name: "Apple User",
            email: "private@privaterelay.appleid.com",
            username: nil,
            displayUsername: nil,
            image: nil
        )

        XCTAssertFalse(user.usesPassword)
    }

    func testBetterAuthErrorsAreConvertedToUsefulMessages() throws {
        let data = try XCTUnwrap(
            #"{"message":"Invalid username or password","code":"INVALID_USERNAME_OR_PASSWORD"}"#
                .data(using: .utf8)
        )

        let error = RelayAuthClientError.decode(status: 401, data: data)

        XCTAssertEqual(error.localizedDescription, "The username or password is incorrect.")
    }

    func testAppleLinkConflictExplainsTheOtherAccount() throws {
        let data = try XCTUnwrap(
            #"{"message":"account not linked","code":"OAUTH_LINK_ERROR"}"#
                .data(using: .utf8)
        )
        let error = RelayAuthClientError.decode(status: 401, data: data)
        XCTAssertEqual(
            error.localizedDescription,
            "This Apple ID is already used on a different Relay account. Sign in with your username and password, or use the Apple ID that created that account."
        )
    }

    // MARK: - Coding Agents (Antigravity + Codex + Claude Code)

    func testDisplayedHarnessesShowsAntigravityInstalledUninstalledAndFallbackForOlderRelayd() {
        XCTAssertTrue(AccountSettingsHelpers.displayedHarnesses(from: []).isEmpty)

        // Case 1: Modern relayd with Antigravity installed alongside Codex, Claude Code, and Kimi.
        let installedInput = [
            RelayHarnessStatus(provider: .kimi, installed: true, loggedIn: true, authKind: "subscription"),
            RelayHarnessStatus(provider: .antigravity, installed: true, version: "agy 0.1.0", loggedIn: false, authKind: "oauth"),
            RelayHarnessStatus(provider: .claude, installed: true, loggedIn: true, authKind: "subscription"),
            RelayHarnessStatus(provider: .codex, installed: true, loggedIn: true, authKind: "subscription"),
        ]
        let installedRows = AccountSettingsHelpers.displayedHarnesses(from: installedInput)
        XCTAssertEqual(installedRows.map(\.provider), [.codex, .claude, .antigravity, .kimi])
        XCTAssertEqual(installedRows[2].installed, true)
        XCTAssertEqual(installedRows[2].loggedIn, false)

        // Case 2: Modern relayd reporting Antigravity as not installed (while uninstalled Kimi stays hidden).
        let uninstalledInput = [
            RelayHarnessStatus(provider: .codex, installed: true, loggedIn: true, authKind: "subscription"),
            RelayHarnessStatus(provider: .claude, installed: true, loggedIn: false, authKind: "subscription"),
            RelayHarnessStatus(provider: .antigravity, installed: false, loggedIn: nil, authKind: "unknown"),
            RelayHarnessStatus(provider: .kimi, installed: false, loggedIn: nil, authKind: "unknown"),
        ]
        let uninstalledRows = AccountSettingsHelpers.displayedHarnesses(from: uninstalledInput)
        XCTAssertEqual(uninstalledRows.map(\.provider), [.codex, .claude, .antigravity])
        XCTAssertFalse(uninstalledRows[2].installed)
        XCTAssertFalse(uninstalledRows[2].supportsDirectLogin)

        // Case 3: Older relayd that omits Antigravity completely — synthesize a sign-in row right after Claude Code.
        let legacyInput = [
            RelayHarnessStatus(provider: .claude, installed: true, loggedIn: true, authKind: "subscription"),
            RelayHarnessStatus(provider: .codex, installed: true, loggedIn: true, authKind: "subscription"),
            RelayHarnessStatus(provider: .kimi, installed: false, loggedIn: nil, authKind: "unknown"),
        ]
        let legacyRows = AccountSettingsHelpers.displayedHarnesses(from: legacyInput)
        XCTAssertEqual(legacyRows.map(\.provider), [.codex, .claude, .antigravity])
        XCTAssertTrue(legacyRows[2].installed)
        XCTAssertNil(legacyRows[2].loggedIn)
        XCTAssertEqual(legacyRows[2].authKind, "unknown")
    }

    @MainActor
    func testSettingsCodingAgentsDisplaysAntigravityAlongsideCodexAndClaude() throws {
        let server = try LocalHarnessHTTPStubServer { path in
            if path.hasPrefix("/v1/harness/antigravity/login") {
                return (
                    200,
                    #"{"op":{"id":"op-agy-ui","provider":"antigravity","action":"login","status":"running"}}"#
                )
            }
            if path.hasPrefix("/v1/harness/ops/op-agy-ui") {
                return (
                    200,
                    #"{"op":{"id":"op-agy-ui","provider":"antigravity","action":"login","status":"running"}}"#
                )
            }
            if path.hasPrefix("/v1/harness") {
                return (
                    200,
                    """
                    {"harnesses":[
                      {"provider":"codex","installed":true,"loggedIn":true,"authKind":"subscription"},
                      {"provider":"claude","installed":true,"loggedIn":false,"authKind":"subscription"},
                      {"provider":"antigravity","installed":true,"loggedIn":false,"authKind":"unknown"}
                    ]}
                    """
                )
            }
            return (404, #"{"error":"not found"}"#)
        }
        defer { server.stop() }

        let deps = try makeInteractiveDependencies(baseURL: server.baseURL)
        defer { deps.cleanup() }

        let pairedHost = RelayPairedNode(
            nodeID: "node-coding-agents-test",
            nodeName: "Dev Box",
            apiBaseURL: server.baseURL
        )
        deps.nodeStore.adopt(pairedHost)

        let probe = SettingsSheetHostProbe()
        let rootVC = UIHostingController(
            rootView: DrivenSettingsSheetHost(deps: deps, probe: probe)
        )
        let harness = try RelayLiveUIWindowHarness(rootViewController: rootVC)
        defer { harness.tearDown() }

        let settingsVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: rootVC),
            "AccountSettingsView did not present inside its parent sheet"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: settingsVC,
            description: "Coding agents & sign-ins",
            identifier: "relay-settings-coding-agents",
            labelMatches: { $0.localizedCaseInsensitiveContains("Coding agents") }
        )

        let hasCodex = RelayLiveUIWindowHarness.waitForElement(
            in: settingsVC.view,
            identifier: "relay-agent-connected-codex",
            labelMatches: { $0 == "Codex" },
            timeout: 4.0
        )
        XCTAssertTrue(
            hasCodex,
            "Coding agents screen is missing Codex. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: settingsVC.view))"
        )

        let hasClaude = RelayLiveUIWindowHarness.waitForElement(
            in: settingsVC.view,
            identifier: "relay-agent-sign-in-claude",
            labelMatches: { $0 == "Claude Code" },
            timeout: 3.0
        )
        XCTAssertTrue(
            hasClaude,
            "Coding agents screen is missing Claude Code. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: settingsVC.view))"
        )

        let hasAntigravity = RelayLiveUIWindowHarness.waitForElement(
            in: settingsVC.view,
            identifier: "relay-agent-sign-in-antigravity",
            labelMatches: { $0 == "Antigravity" },
            timeout: 3.0
        )
        XCTAssertTrue(
            hasAntigravity,
            "Coding agents screen is missing Antigravity alongside Codex and Claude Code. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: settingsVC.view))"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: settingsVC,
            description: "Sign in to Antigravity",
            identifier: "relay-agent-sign-in-antigravity",
            labelMatches: nil
        )

        let loginVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: settingsVC),
            "Tapping Antigravity Sign in did not present ProviderLoginView"
        )

        let hasLoginTitle = RelayLiveUIWindowHarness.waitForElement(
            in: loginVC.view,
            identifier: "relay-provider-login-close",
            labelMatches: { $0.localizedCaseInsensitiveContains("Antigravity") },
            timeout: 3.0
        )
        XCTAssertTrue(
            hasLoginTitle,
            "Antigravity ProviderLoginView sheet did not render expected controls. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: loginVC.view))"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: loginVC,
            description: "Cancel Antigravity sign-in",
            identifier: "relay-provider-login-close",
            labelMatches: { $0 == "Cancel" || $0 == "Done" }
        )
        XCTAssertTrue(
            RelayLiveUIWindowHarness.waitForDismissal(ofChildFrom: settingsVC),
            "Closing Antigravity ProviderLoginView did not dismiss the sheet"
        )
    }

    // MARK: - Live UIWindow Interactive Sheet & Host Switcher Flows

    @MainActor
    func testSettingsAddConnectionPresentsNodePairingSheet() throws {
        let deps = try makeInteractiveDependencies()
        defer { deps.cleanup() }

        let probe = SettingsSheetHostProbe()
        let rootVC = UIHostingController(
            rootView: DrivenSettingsSheetHost(deps: deps, probe: probe)
        )
        let harness = try RelayLiveUIWindowHarness(rootViewController: rootVC)
        defer { harness.tearDown() }

        let settingsVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: rootVC),
            "AccountSettingsView did not present inside its parent sheet"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: settingsVC,
            description: "Add connection",
            identifier: "relay-settings-pair",
            labelMatches: { $0.localizedCaseInsensitiveContains("Add connection") }
        )

        let pairingVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: settingsVC),
            "Activating Add connection did not present a child NodePairingView sheet on Settings"
        )

        let hasHeading = RelayLiveUIWindowHarness.waitForElement(
            in: pairingVC.view,
            identifier: "relay-node-pairing",
            labelMatches: { $0.localizedCaseInsensitiveContains("Connect your machine") }
        )
        XCTAssertTrue(
            hasHeading,
            "NodePairingView sheet is missing 'Connect your machine' / 'relay-node-pairing'. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: pairingVC.view))"
        )

        let hasManualEntry = RelayLiveUIWindowHarness.waitForElement(
            in: pairingVC.view,
            identifier: "relay-pair-manual-toggle",
            labelMatches: { $0.localizedCaseInsensitiveContains("Enter it by hand") }
        )
        XCTAssertTrue(
            hasManualEntry,
            "NodePairingView sheet is missing 'Enter it by hand'. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: pairingVC.view))"
        )

        let hasPasteLink = RelayLiveUIWindowHarness.waitForElement(
            in: pairingVC.view,
            identifier: "relay-pair-paste-link",
            labelMatches: { $0.localizedCaseInsensitiveContains("Paste pairing link") }
        )
        XCTAssertTrue(
            hasPasteLink,
            "NodePairingView sheet is missing 'Paste pairing link' ('relay-pair-paste-link'). Visible: \(RelayLiveUIWindowHarness.debugSummary(in: pairingVC.view))"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: pairingVC,
            description: "Close",
            identifier: nil,
            labelMatches: { $0 == "Close" }
        )

        XCTAssertTrue(
            RelayLiveUIWindowHarness.waitForDismissal(ofChildFrom: settingsVC),
            "Activating Close did not dismiss the NodePairingView child sheet"
        )
        XCTAssertNotNil(
            RelayLiveUIWindowHarness.activePresentedChild(from: rootVC),
            "Settings sheet should remain open after closing the NodePairingView child sheet"
        )
    }

    @MainActor
    func testSettingsSignInPresentsAuthSheet() throws {
        let deps = try makeInteractiveDependencies()
        defer { deps.cleanup() }
        XCTAssertNil(deps.accountStore.user, "Precondition: accountStore must start signed out")

        let probe = SettingsSheetHostProbe()
        let rootVC = UIHostingController(
            rootView: DrivenSettingsSheetHost(deps: deps, probe: probe)
        )
        let harness = try RelayLiveUIWindowHarness(rootViewController: rootVC)
        defer { harness.tearDown() }

        let settingsVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: rootVC),
            "AccountSettingsView did not present inside its parent sheet"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: settingsVC,
            description: "Sign in to Relay",
            identifier: "relay-settings-sign-in",
            labelMatches: { $0.localizedCaseInsensitiveContains("Sign in to Relay") }
        )

        let authVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: settingsVC),
            "Activating Sign in to Relay did not present the AuthenticationView child sheet"
        )

        let hasAuthContent = RelayLiveUIWindowHarness.waitForElement(
            in: authVC.view,
            identifier: "relay-username",
            labelMatches: {
                $0.localizedCaseInsensitiveContains("Username")
                    || $0.localizedCaseInsensitiveContains("Sign in")
            }
        )
        XCTAssertTrue(
            hasAuthContent,
            "Presented auth sheet did not render AuthenticationView controls. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: authVC.view))"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: authVC,
            description: "Cancel",
            identifier: nil,
            labelMatches: { $0 == "Cancel" || $0 == "Close" }
        )

        XCTAssertTrue(
            RelayLiveUIWindowHarness.waitForDismissal(ofChildFrom: settingsVC),
            "Activating Cancel did not dismiss the AuthenticationView child sheet"
        )
        XCTAssertNotNil(
            RelayLiveUIWindowHarness.activePresentedChild(from: rootVC),
            "Settings sheet should remain open after dismissing the AuthenticationView child sheet"
        )
    }

    @MainActor
    func testSidebarHostSwitcherAddHostDefersUntilDismiss() throws {
        let deps = try makeInteractiveDependencies()
        defer { deps.cleanup() }

        let pairedHost = RelayPairedNode(
            nodeID: "node-sidebar-switcher-test",
            nodeName: "Studio Mac",
            apiBaseURL: try XCTUnwrap(URL(string: "https://studio-mac.local:8443"))
        )
        deps.nodeStore.adopt(pairedHost)

        let feed = StatusFeedViewModel(
            source: StubChatsFeedSource(),
            machineURL: pairedHost.apiBaseURL,
            snapshotStore: nil
        )
        let probe = SidebarAddHostProbe()
        let rootVC = UIHostingController(
            rootView: DrivenSidebarAddHostContainer(
                feed: feed,
                deps: deps,
                probe: probe
            )
        )
        let harness = try RelayLiveUIWindowHarness(rootViewController: rootVC)
        defer { harness.tearDown() }

        RelayLiveUIWindowHarness.settle(0.6)

        try RelayLiveUIWindowHarness.activateControl(
            in: rootVC,
            description: "Active host pill",
            identifier: "relay-sidebar-host-pill",
            labelMatches: { $0.localizedCaseInsensitiveContains("Active host") }
        )

        let switcherVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(from: rootVC),
            "Activating the sidebar host pill did not present RelayHostSwitcherSheet"
        )

        try RelayLiveUIWindowHarness.activateControl(
            in: switcherVC,
            description: "Add host",
            identifier: "relay-host-switcher-add-host",
            labelMatches: { $0.localizedCaseInsensitiveContains("Add host") }
        )

        // Allow the host switcher sheet to finish dismissing and the deferred
        // parent NodePairingView sheet to present without a UIKit same-tick drop.
        RelayLiveUIWindowHarness.settle(1.2)

        let pairingVC = try XCTUnwrap(
            RelayLiveUIWindowHarness.waitForPresentedChild(
                from: rootVC,
                excluding: switcherVC,
                timeout: 1.5
            ),
            "Parent NodePairingView sheet did not present after activating Add host (likely dropped by a same-tick sheet race)"
        )

        XCTAssertEqual(probe.addHostCallbackCount, 1, "onAddHost should fire once after host switcher dismissal")
        XCTAssertTrue(probe.showingAddHost, "Parent showingAddHost binding should remain true while pairing is presented")
        XCTAssertFalse(pairingVC === switcherVC, "Presented sheet must be the new NodePairingView, not the host switcher")

        let hasPairingHeading = RelayLiveUIWindowHarness.waitForElement(
            in: pairingVC.view,
            identifier: "relay-node-pairing",
            labelMatches: { $0.localizedCaseInsensitiveContains("Connect your machine") }
        )
        XCTAssertTrue(
            hasPairingHeading,
            "Presented sheet after Add host did not contain 'Connect your machine'. Visible: \(RelayLiveUIWindowHarness.debugSummary(in: pairingVC.view))"
        )
    }

    // MARK: - Interactive Test Fixtures & Harness

    private struct InteractiveTestDependencies {
        let suiteName: String
        let defaults: UserDefaults
        let identityStore: ClientIdentityStore
        let nodeStore: RelayNodeStore
        let authClient: RelayAuthClient
        let accountStore: RelayAccountStore
        let computerLinkStore: RelayComputerLinkStore
        let codexClient: CodexClient
        let powerModel: RelayMachinePowerModel

        func cleanup() {
            identityStore.forgetPairedMaterialForTesting()
            defaults.removePersistentDomain(forName: suiteName)
        }
    }

    @MainActor
    private func makeInteractiveDependencies(baseURL: URL? = nil) throws -> InteractiveTestDependencies {
        let suiteName = "account-interactive-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)

        let offlineURL = try XCTUnwrap(URL(string: "http://127.0.0.1:1"))
        let codexBaseURL = baseURL ?? offlineURL
        let identityStore = ClientIdentityStore(defaults: defaults)
        identityStore.forgetPairedMaterialForTesting()
        let nodeStore = RelayNodeStore(defaults: defaults)
        let authClient = RelayAuthClient(baseURL: offlineURL)
        let accountStore = RelayAccountStore(
            client: authClient,
            identityStore: identityStore,
            defaults: defaults,
            nodeStore: nodeStore
        )
        let computerLinkStore = RelayComputerLinkStore(client: authClient, defaults: defaults)
        let stubPower = StubPowerClient()
        let codexClient = CodexClient(
            baseURL: codexBaseURL,
            identityStore: identityStore,
            powerClient: stubPower
        )
        let powerModel = RelayMachinePowerModel(powerClient: stubPower)
        powerModel.configure(identityStore: identityStore)

        return InteractiveTestDependencies(
            suiteName: suiteName,
            defaults: defaults,
            identityStore: identityStore,
            nodeStore: nodeStore,
            authClient: authClient,
            accountStore: accountStore,
            computerLinkStore: computerLinkStore,
            codexClient: codexClient,
            powerModel: powerModel
        )
    }

    @MainActor
    private final class SettingsSheetHostProbe: ObservableObject {
        @Published var showingSettings = true
    }

    private struct DrivenSettingsSheetHost: View {
        let deps: InteractiveTestDependencies
        @ObservedObject var probe: SettingsSheetHostProbe

        var body: some View {
            Color.black
                .ignoresSafeArea()
                .sheet(isPresented: $probe.showingSettings) {
                    AccountSettingsView(
                        accountStore: deps.accountStore,
                        nodeStore: deps.nodeStore,
                        identityStore: deps.identityStore,
                        computerLinkStore: deps.computerLinkStore,
                        codexClient: deps.codexClient,
                        authClient: deps.authClient,
                        powerModel: deps.powerModel
                    )
                    .environment(\.relayTheme, RelayThemeStore.shared.palette)
                    .preferredColorScheme(RelayThemeStore.shared.colorScheme)
                }
        }
    }

    @MainActor
    private final class SidebarAddHostProbe: ObservableObject {
        @Published var showingAddHost = false
        var addHostCallbackCount = 0
    }

    private struct DrivenSidebarAddHostContainer: View {
        @ObservedObject var feed: StatusFeedViewModel
        let deps: InteractiveTestDependencies
        @ObservedObject var probe: SidebarAddHostProbe

        var body: some View {
            RelayWorkspacesSidebar(
                feed: feed,
                nodeStore: deps.nodeStore,
                identityStore: deps.identityStore,
                powerModel: deps.powerModel,
                onSelectWorkspace: { _ in },
                onSelectThread: { _ in },
                onAddHost: {
                    probe.addHostCallbackCount += 1
                    probe.showingAddHost = true
                },
                onOpenSettings: {}
            )
            .environment(\.relayTheme, RelayThemeStore.shared.palette)
            .preferredColorScheme(RelayThemeStore.shared.colorScheme)
            .sheet(isPresented: $probe.showingAddHost) {
                NodePairingView(
                    identityStore: deps.identityStore,
                    nodeStore: deps.nodeStore,
                    accountStore: deps.accountStore,
                    authClient: deps.authClient,
                    onDismiss: { probe.showingAddHost = false }
                )
                .environment(\.relayTheme, RelayThemeStore.shared.palette)
                .preferredColorScheme(RelayThemeStore.shared.colorScheme)
            }
        }
    }

    private final class StubPowerClient: RelayMachinePowering {
        func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }

        func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }

        func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }

        func resize(nodeID: String, wakeToken: String, from: String, to: String) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }

        func setAutoStop(nodeID: String, wakeToken: String, enabled: Bool) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }
    }

    private final class StubChatsFeedSource: RelayChatsFeedSource {
        func fetchChatsThreads(budget: CodexRequestBudget) async throws -> [CodexThread] { [] }
        func fetchChatsJobs(budget: CodexRequestBudget) async throws -> [CodexJob] { [] }
        func fetchChatsApprovals(budget: CodexRequestBudget) async throws -> [CodexApproval] { [] }
        func decideApproval(
            id: String,
            decision: CodexApprovalDecision,
            message: String?,
            answers: [String: String]?
        ) async throws -> CodexApproval {
            throw URLError(.cancelled)
        }
    }
}

@MainActor
private final class RelayLiveUIWindowHarness {
    private static var didEnableAccessibility = false

    let window: UIWindow
    let rootViewController: UIViewController

    init(rootViewController: UIViewController, size: CGSize = CGSize(width: 402, height: 874)) throws {
        Self.enableAccessibilityAutomation()
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first else {
            throw XCTSkip("Live UIWindow tests require an active UIWindowScene")
        }

        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(origin: .zero, size: size)
        window.windowLevel = .alert + 1
        window.rootViewController = rootViewController
        window.makeKeyAndVisible()
        self.window = window
        self.rootViewController = rootViewController
    }

    func tearDown() {
        if rootViewController.presentedViewController != nil {
            rootViewController.dismiss(animated: false)
            Self.settle(0.25)
        }
        window.isHidden = true
        window.rootViewController = nil
        window.windowScene = nil
    }

    static func enableAccessibilityAutomation() {
        guard !didEnableAccessibility else { return }
        didEnableAccessibility = true
        if let library = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
           let symbol = dlsym(library, "_AXSSetAutomationEnabled") {
            unsafeBitCast(symbol, to: (@convention(c) (Int32) -> Void).self)(1)
        }
    }

    static func settle(_ seconds: TimeInterval = 0.5) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    static func rawPresentedChild(from vc: UIViewController) -> UIViewController? {
        if let presented = vc.presentedViewController {
            return presented
        }
        for child in vc.children {
            if let presented = rawPresentedChild(from: child) {
                return presented
            }
        }
        return nil
    }

    static func activePresentedChild(from vc: UIViewController) -> UIViewController? {
        guard let presented = rawPresentedChild(from: vc), !presented.isBeingDismissed else {
            return nil
        }
        return presented
    }

    static func waitForPresentedChild(
        from vc: UIViewController,
        excluding excluded: UIViewController? = nil,
        timeout: TimeInterval = 3.0
    ) -> UIViewController? {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let presented = rawPresentedChild(from: vc),
               presented !== excluded,
               !presented.isBeingPresented,
               !presented.isBeingDismissed {
                settle(0.2)
                if !presented.isBeingDismissed, rawPresentedChild(from: vc) === presented {
                    return presented
                }
            }
            settle(0.05)
        }
        return nil
    }

    static func waitForDismissal(ofChildFrom vc: UIViewController, timeout: TimeInterval = 3.0) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if rawPresentedChild(from: vc) == nil {
                settle(0.15)
                return rawPresentedChild(from: vc) == nil
            }
            settle(0.05)
        }
        return rawPresentedChild(from: vc) == nil
    }

    static func waitForElement(
        in rootView: UIView,
        identifier: String?,
        labelMatches: ((String) -> Bool)?,
        timeout: TimeInterval = 2.0
    ) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !findMatchingNodes(
                in: rootView,
                identifier: identifier,
                labelMatches: labelMatches,
                scrollIfNeeded: true
            ).isEmpty {
                return true
            }
            settle(0.1)
        }
        return false
    }

    static func activateControl(
        in vc: UIViewController,
        description: String,
        identifier: String?,
        labelMatches: ((String) -> Bool)?,
        timeout: TimeInterval = 2.5
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        var candidates: [Candidate] = []
        while Date() < deadline {
            candidates = findActivatableCandidates(
                in: vc.view,
                identifier: identifier,
                labelMatches: labelMatches,
                scrollIfNeeded: true
            )
            if !candidates.isEmpty { break }
            settle(0.1)
        }

        if candidates.isEmpty {
            if tryActivateNavigationBarItem(in: vc, identifier: identifier, labelMatches: labelMatches) {
                settle(0.3)
                return
            }
            XCTFail(
                "No control '\(description)' (id: \(identifier ?? "nil")) found. Visible elements: \(debugSummary(in: vc.view))"
            )
            return
        }

        for candidate in candidates {
            if candidate.object.accessibilityActivate() {
                settle(0.3)
                return
            }
        }

        for candidate in candidates {
            if triggerUIControlIfPresent(for: candidate.object) {
                settle(0.3)
                return
            }
        }

        if tryActivateNavigationBarItem(in: vc, identifier: identifier, labelMatches: labelMatches) {
            settle(0.3)
            return
        }

        XCTFail(
            "Control '\(description)' (id: \(identifier ?? "nil")) did not respond to accessibilityActivate()"
        )
    }

    private struct Candidate {
        let object: NSObject
        let priority: Int
    }

    private static func findMatchingNodes(
        in rootView: UIView,
        identifier: String?,
        labelMatches: ((String) -> Bool)?,
        scrollIfNeeded: Bool
    ) -> [NSObject] {
        var matches = collectMatchingNodes(in: rootView, identifier: identifier, labelMatches: labelMatches)
        if !matches.isEmpty || !scrollIfNeeded {
            return matches
        }
        for scrollView in collectScrollViews(in: rootView) {
            let maxOffsetY = max(0, scrollView.contentSize.height - scrollView.bounds.height)
            guard maxOffsetY > 1 else { continue }
            let step = max(200, scrollView.bounds.height * 0.7)
            var offsetY = step
            while offsetY <= maxOffsetY + step {
                let clamped = min(offsetY, maxOffsetY)
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: clamped), animated: false)
                scrollView.layoutIfNeeded()
                settle(0.1)
                matches = collectMatchingNodes(in: rootView, identifier: identifier, labelMatches: labelMatches)
                if !matches.isEmpty {
                    return matches
                }
                if clamped >= maxOffsetY { break }
                offsetY += step
            }
        }
        return matches
    }

    private static func findActivatableCandidates(
        in rootView: UIView,
        identifier: String?,
        labelMatches: ((String) -> Bool)?,
        scrollIfNeeded: Bool
    ) -> [Candidate] {
        var candidates = collectActivatableCandidates(
            in: rootView,
            identifier: identifier,
            labelMatches: labelMatches
        )
        if !candidates.isEmpty || !scrollIfNeeded {
            return candidates
        }
        for scrollView in collectScrollViews(in: rootView) {
            let maxOffsetY = max(0, scrollView.contentSize.height - scrollView.bounds.height)
            guard maxOffsetY > 1 else { continue }
            let step = max(200, scrollView.bounds.height * 0.7)
            var offsetY = step
            while offsetY <= maxOffsetY + step {
                let clamped = min(offsetY, maxOffsetY)
                scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: clamped), animated: false)
                scrollView.layoutIfNeeded()
                settle(0.1)
                candidates = collectActivatableCandidates(
                    in: rootView,
                    identifier: identifier,
                    labelMatches: labelMatches
                )
                if !candidates.isEmpty {
                    return candidates
                }
                if clamped >= maxOffsetY { break }
                offsetY += step
            }
        }
        return candidates
    }

    private static func collectMatchingNodes(
        in root: NSObject,
        identifier: String?,
        labelMatches: ((String) -> Bool)?
    ) -> [NSObject] {
        var results: [NSObject] = []
        var visited = Set<ObjectIdentifier>()

        func walk(_ node: NSObject, depth: Int) {
            guard depth < 80 else { return }
            let oid = ObjectIdentifier(node)
            guard visited.insert(oid).inserted else { return }

            let nodeID = accessibilityIdentifier(of: node)
            let nodeLabel = node.accessibilityLabel
            let idMatched = identifier != nil && nodeID == identifier
            let labelMatched = node.isAccessibilityElement && nodeLabel.map { labelMatches?($0) ?? false } == true

            if idMatched || labelMatched {
                results.append(node)
            }

            for child in accessibilityChildren(of: node) {
                walk(child, depth: depth + 1)
            }
        }

        walk(root, depth: 0)
        return results
    }

    private static func collectActivatableCandidates(
        in root: NSObject,
        identifier: String?,
        labelMatches: ((String) -> Bool)?
    ) -> [Candidate] {
        var candidates: [Candidate] = []
        var visited = Set<ObjectIdentifier>()

        func collectInteractiveDescendants(of container: NSObject, depth: Int, basePriority: Int) {
            guard depth < 12 else { return }
            for child in accessibilityChildren(of: container) {
                if child.isAccessibilityElement {
                    let isButton = child.accessibilityTraits.contains(.button) || child is UIControl
                    candidates.append(Candidate(object: child, priority: basePriority + (isButton ? 0 : 1)))
                }
                collectInteractiveDescendants(of: child, depth: depth + 1, basePriority: basePriority)
            }
        }

        func walk(_ node: NSObject, depth: Int) {
            guard depth < 80 else { return }
            let oid = ObjectIdentifier(node)
            guard visited.insert(oid).inserted else { return }

            let nodeID = accessibilityIdentifier(of: node)
            let nodeLabel = node.accessibilityLabel
            let isButton = node.accessibilityTraits.contains(.button) || node is UIControl

            if let identifier, nodeID == identifier {
                if node.isAccessibilityElement || node is UIControl {
                    candidates.append(Candidate(object: node, priority: isButton ? 0 : 1))
                } else {
                    collectInteractiveDescendants(of: node, depth: 0, basePriority: 2)
                }
            } else if node.isAccessibilityElement, let nodeLabel, labelMatches?(nodeLabel) == true {
                candidates.append(Candidate(object: node, priority: isButton ? 4 : 5))
            }

            for child in accessibilityChildren(of: node) {
                walk(child, depth: depth + 1)
            }
        }

        walk(root, depth: 0)

        var seen = Set<ObjectIdentifier>()
        return candidates
            .sorted { $0.priority < $1.priority }
            .filter { seen.insert(ObjectIdentifier($0.object)).inserted }
    }

    private static func accessibilityChildren(of root: NSObject) -> [NSObject] {
        var children: [NSObject] = (root.accessibilityElements ?? []).compactMap { $0 as? NSObject }
        if children.isEmpty {
            let count = root.accessibilityElementCount()
            if count != NSNotFound, count > 0 {
                children = (0..<count).compactMap { root.accessibilityElement(at: $0) as? NSObject }
            }
        }
        if let view = root as? UIView {
            children.append(contentsOf: view.subviews)
        }
        return children
    }

    private static func accessibilityIdentifier(of object: NSObject) -> String? {
        if let identifiable = object as? UIAccessibilityIdentification,
           let id = identifiable.accessibilityIdentifier,
           !id.isEmpty {
            return id
        }
        let selector = NSSelectorFromString("accessibilityIdentifier")
        if object.responds(to: selector),
           let unmanaged = object.perform(selector),
           let id = unmanaged.takeUnretainedValue() as? String,
           !id.isEmpty {
            return id
        }
        return nil
    }

    private static func collectScrollViews(in root: UIView) -> [UIScrollView] {
        var result: [UIScrollView] = []
        if let scroll = root as? UIScrollView {
            result.append(scroll)
        }
        for subview in root.subviews {
            result.append(contentsOf: collectScrollViews(in: subview))
        }
        return result
    }

    private static func triggerUIControlIfPresent(for object: NSObject) -> Bool {
        if let control = object as? UIControl {
            if !control.allControlEvents.isEmpty {
                return fire(control)
            }
            if let nested = firstInteractiveControl(in: control), nested !== control {
                return fire(nested)
            }
            return fire(control)
        }
        if let view = object as? UIView {
            if let nested = firstInteractiveControl(in: view) {
                return fire(nested)
            }
            var ancestor = view.superview
            while let current = ancestor {
                if let control = current as? UIControl {
                    return fire(control)
                }
                ancestor = current.superview
            }
        }
        if let element = object as? UIAccessibilityElement,
           let container = element.accessibilityContainer as? UIControl {
            return fire(container)
        }
        return false
    }

    private static func firstInteractiveControl(in root: UIView) -> UIControl? {
        for subview in root.subviews {
            if let control = subview as? UIControl, control.isEnabled, !control.allControlEvents.isEmpty {
                return control
            }
            if let found = firstInteractiveControl(in: subview) {
                return found
            }
        }
        return nil
    }

    private static func fire(_ control: UIControl) -> Bool {
        guard control.isEnabled else { return false }
        let events = control.allControlEvents
        if events.contains(.primaryActionTriggered) {
            control.sendActions(for: .primaryActionTriggered)
        } else {
            control.sendActions(for: .touchUpInside)
        }
        return true
    }

    private static func tryActivateNavigationBarItem(
        in vc: UIViewController,
        identifier: String?,
        labelMatches: ((String) -> Bool)?
    ) -> Bool {
        var controllers: [UIViewController] = [vc]
        var index = 0
        while index < controllers.count {
            let current = controllers[index]
            index += 1
            controllers.append(contentsOf: current.children)
            if let nav = current as? UINavigationController, let top = nav.topViewController {
                let items = (top.navigationItem.leftBarButtonItems ?? [])
                    + (top.navigationItem.rightBarButtonItems ?? [])
                for item in items {
                    let idMatch = identifier != nil && item.accessibilityIdentifier == identifier
                    let label = item.accessibilityLabel ?? item.title
                    let labelMatch = label.map { labelMatches?($0) ?? false } == true
                    guard idMatch || labelMatch else { continue }
                    if let action = item.action {
                        return UIApplication.shared.sendAction(action, to: item.target, from: item, for: nil)
                    }
                }
            }
        }
        return false
    }

    static func debugSummary(in root: NSObject) -> String {
        var entries: [String] = []
        var visited = Set<ObjectIdentifier>()

        func walk(_ node: NSObject, depth: Int) {
            guard depth < 80, entries.count < 40 else { return }
            guard visited.insert(ObjectIdentifier(node)).inserted else { return }
            let id = accessibilityIdentifier(of: node)
            let label = node.isAccessibilityElement ? node.accessibilityLabel : nil
            if id != nil || label != nil {
                entries.append("(label: \(label ?? "nil"), id: \(id ?? "nil"))")
            }
            for child in accessibilityChildren(of: node) {
                walk(child, depth: depth + 1)
            }
        }

        walk(root, depth: 0)
        return entries.joined(separator: ", ")
    }
}

private final class LocalHarnessHTTPStubServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "relay.tests.harness-stub")
    private let responseProvider: (String) -> (Int, String)
    private(set) var port: UInt16 = 0

    var baseURL: URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    init(responseProvider: @escaping (String) -> (Int, String)) throws {
        self.responseProvider = responseProvider
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener

        let ready = DispatchSemaphore(value: 0)
        var didSignal = false
        var readyPort: UInt16?
        let signalOnce = {
            guard !didSignal else { return }
            didSignal = true
            ready.signal()
        }

        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                readyPort = listener.port?.rawValue
                signalOnce()
            case .failed, .cancelled:
                signalOnce()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.handle(connection)
        }
        listener.start(queue: queue)

        guard ready.wait(timeout: .now() + 3) == .success, let boundPort = readyPort, boundPort > 0 else {
            listener.cancel()
            throw XCTSkip("Could not bind local loopback HTTP stub server")
        }
        self.port = boundPort
    }

    func stop() {
        listener.cancel()
    }

    private func handle(_ connection: NWConnection) {
        connection.start(queue: queue)
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, _, _ in
            guard let self else {
                connection.cancel()
                return
            }
            let requestLine = data
                .flatMap { String(data: $0, encoding: .utf8) }?
                .components(separatedBy: "\r\n")
                .first ?? ""
            let path = requestLine.split(separator: " ").dropFirst().first.map(String.init) ?? "/"
            let (status, body) = self.responseProvider(path)
            let bodyData = Data(body.utf8)
            let statusText: String
            switch status {
            case 200: statusText = "OK"
            case 202: statusText = "Accepted"
            case 400: statusText = "Bad Request"
            default: statusText = "Not Found"
            }
            let header = "HTTP/1.1 \(status) \(statusText)\r\n"
                + "Content-Type: application/json\r\n"
                + "Content-Length: \(bodyData.count)\r\n"
                + "Connection: close\r\n\r\n"
            var payload = Data(header.utf8)
            payload.append(bodyData)
            connection.send(content: payload, completion: .contentProcessed { _ in
                connection.cancel()
            })
        }
    }
}
