import CarPlay
import Foundation
import UIKit

@MainActor
final class RelayCarPlaySceneDelegate: UIResponder, CPTemplateApplicationSceneDelegate {
    private var interfaceController: CPInterfaceController?
    private let identityStore = ClientIdentityStore()
    private lazy var manifestClient = ManifestClient(
        manifestURL: AppConfiguration.manifestURL,
        signatureURL: AppConfiguration.signatureURL,
        identityStore: identityStore,
        trustedPublicKeyRawRepresentation: AppConfiguration.trustedManifestPublicKey
    )
    private lazy var codexClient = CodexClient(
        baseURL: AppConfiguration.codexBaseURL,
        identityStore: identityStore
    )
    private var refreshTask: Task<Void, Never>?

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didConnect interfaceController: CPInterfaceController
    ) {
        self.interfaceController = interfaceController
        interfaceController.prefersDarkUserInterfaceStyle = true
        identityStore.importIdentityFromSetupEnvironmentIfNeeded()

        setRootTemplate(RelayCarPlayTemplateFactory.loadingTemplate(refreshHandler: refresh))
        refresh()
    }

    func templateApplicationScene(
        _ templateApplicationScene: CPTemplateApplicationScene,
        didDisconnectInterfaceController interfaceController: CPInterfaceController
    ) {
        refreshTask?.cancel()
        refreshTask = nil
        self.interfaceController = nil
    }

    private func refresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            guard let self else { return }
            let snapshot = await self.loadSnapshot()
            guard !Task.isCancelled else { return }
            self.setRootTemplate(RelayCarPlayTemplateFactory.dashboardTemplate(snapshot: snapshot, refreshHandler: self.refresh))
        }
    }

    private func loadSnapshot() async -> RelayCarPlayDashboardSnapshot {
        async let manifest = optionalResult { try await manifestClient.fetchManifest() }
        async let health = optionalResult { try await codexClient.fetchHealth() }
        async let codexThreads = fallbackResult([]) { try await codexClient.fetchThreads(provider: .codex, limit: 12) }
        async let codexJobs = fallbackResult([]) { try await codexClient.fetchJobs(provider: .codex, limit: 12) }
        async let claudeThreads = fallbackResult([]) { try await codexClient.fetchThreads(provider: .claude, limit: 12) }
        async let claudeJobs = fallbackResult([]) { try await codexClient.fetchJobs(provider: .claude, limit: 12) }

        return await RelayCarPlayDashboardSnapshot.make(
            manifest: manifest,
            health: health,
            codexThreads: codexThreads,
            codexJobs: codexJobs,
            claudeThreads: claudeThreads,
            claudeJobs: claudeJobs
        )
    }

    private func setRootTemplate(_ template: CPListTemplate) {
        interfaceController?.setRootTemplate(template, animated: false) { _, _ in }
    }

    private func optionalResult<T>(_ operation: () async throws -> T) async -> T? {
        try? await operation()
    }

    private func fallbackResult<T>(_ fallback: T, _ operation: () async throws -> T) async -> T {
        (try? await operation()) ?? fallback
    }
}

enum RelayCarPlayTemplateFactory {
    static func loadingTemplate(refreshHandler: @escaping () -> Void) -> CPListTemplate {
        let template = CPListTemplate(
            title: "Relay",
            sections: [
                CPListSection(
                    items: [
                        CPListItem(text: "Loading Relay", detailText: "Fetching agent activity and vault status")
                    ],
                    header: "Status",
                    sectionIndexTitle: nil
                )
            ]
        )
        template.trailingNavigationBarButtons = [refreshButton(refreshHandler: refreshHandler)]
        return template
    }

    static func dashboardTemplate(
        snapshot: RelayCarPlayDashboardSnapshot,
        refreshHandler: @escaping () -> Void
    ) -> CPListTemplate {
        let sections = [
            statusSection(snapshot: snapshot),
            providerSection(snapshot: snapshot),
            activitySection(snapshot: snapshot)
        ]
        let template = CPListTemplate(title: "Relay", sections: sections)
        template.trailingNavigationBarButtons = [refreshButton(refreshHandler: refreshHandler)]
        return template
    }

    private static func statusSection(snapshot: RelayCarPlayDashboardSnapshot) -> CPListSection {
        CPListSection(
            items: [
                CPListItem(text: snapshot.statusTitle, detailText: snapshot.statusDetail)
            ],
            header: "Status",
            sectionIndexTitle: nil
        )
    }

    private static func providerSection(snapshot: RelayCarPlayDashboardSnapshot) -> CPListSection {
        let items = snapshot.providerSummaries.map {
            CPListItem(text: $0.title, detailText: $0.detail)
        }
        return CPListSection(items: items, header: "Agents", sectionIndexTitle: nil)
    }

    private static func activitySection(snapshot: RelayCarPlayDashboardSnapshot) -> CPListSection {
        let items: [CPListItem]
        if snapshot.activityItems.isEmpty {
            items = [CPListItem(text: "No recent activity", detailText: "Start a run on iPhone to see it here")]
        } else {
            items = snapshot.activityItems.map {
                CPListItem(text: $0.title, detailText: $0.detail)
            }
        }
        return CPListSection(items: items, header: "Recent", sectionIndexTitle: nil)
    }

    private static func refreshButton(refreshHandler: @escaping () -> Void) -> CPBarButton {
        let button = CPBarButton(title: "Refresh") { _ in
            refreshHandler()
        }
        button.buttonStyle = .rounded
        return button
    }
}
