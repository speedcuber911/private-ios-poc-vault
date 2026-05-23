import Foundation

struct RelayCarPlayProviderSummary: Equatable {
    let title: String
    let detail: String
}

struct RelayCarPlayActivityItem: Equatable, Identifiable {
    let id: String
    let title: String
    let detail: String
}

struct RelayCarPlayDashboardSnapshot: Equatable {
    let generatedAt: Date
    let statusTitle: String
    let statusDetail: String
    let providerSummaries: [RelayCarPlayProviderSummary]
    let activityItems: [RelayCarPlayActivityItem]

    static func make(
        manifest: POCManifest?,
        health: CodexHealth?,
        codexThreads: [CodexThread],
        codexJobs: [CodexJob],
        claudeThreads: [CodexThread],
        claudeJobs: [CodexJob],
        now: Date = Date()
    ) -> RelayCarPlayDashboardSnapshot {
        let feeds: [(provider: CodexProvider, items: [CodexThreadFeedItem])] = [
            (.codex, CodexThreadFeedItem.makeFeed(threads: codexThreads, jobs: codexJobs)),
            (.claude, CodexThreadFeedItem.makeFeed(threads: claudeThreads, jobs: claudeJobs))
        ]
        let allItems = feeds
            .flatMap(\.items)
            .sorted {
                ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast)
            }
        let activeCount = allItems.filter(\.isActive).count
        let attentionCount = allItems.filter { $0.status?.needsAttention == true }.count
        let pocCount = manifest?.entries.count ?? 0

        return RelayCarPlayDashboardSnapshot(
            generatedAt: now,
            statusTitle: statusTitle(health: health, activeCount: activeCount, attentionCount: attentionCount),
            statusDetail: statusDetail(activeCount: activeCount, attentionCount: attentionCount, pocCount: pocCount),
            providerSummaries: feeds.map { providerSummary(provider: $0.provider, items: $0.items) },
            activityItems: allItems.prefix(6).map(activityItem)
        )
    }

    private static func statusTitle(health: CodexHealth?, activeCount: Int, attentionCount: Int) -> String {
        if health?.isHealthy == false || attentionCount > 0 {
            return activeCount > 0 ? "Relay is working" : "Relay needs attention"
        }
        if activeCount > 0 {
            return "Relay is working"
        }
        return "Relay ready"
    }

    private static func statusDetail(activeCount: Int, attentionCount: Int, pocCount: Int) -> String {
        [
            countPhrase(activeCount, singular: "active run", plural: "active runs"),
            countPhrase(attentionCount, singular: "needs attention", plural: "need attention"),
            countPhrase(pocCount, singular: "POC", plural: "POCs")
        ]
        .joined(separator: " / ")
    }

    private static func providerSummary(provider: CodexProvider, items: [CodexThreadFeedItem]) -> RelayCarPlayProviderSummary {
        let activeCount = items.filter(\.isActive).count
        let attentionCount = items.filter { $0.status?.needsAttention == true }.count
        let firstPart: String
        if attentionCount > 0 {
            firstPart = countPhrase(attentionCount, singular: "attention", plural: "attention")
        } else {
            firstPart = countPhrase(activeCount, singular: "active", plural: "active")
        }

        return RelayCarPlayProviderSummary(
            title: provider.displayName,
            detail: "\(firstPart) / \(countPhrase(items.count, singular: "recent", plural: "recent"))"
        )
    }

    private static func activityItem(from feedItem: CodexThreadFeedItem) -> RelayCarPlayActivityItem {
        let status = feedItem.status?.label ?? "Recent"
        return RelayCarPlayActivityItem(
            id: feedItem.id,
            title: "\(providerName(for: feedItem)): \(shortened(feedItem.title, limit: 54))",
            detail: "\(status) / \(shortened(feedItem.workspaceLabel, limit: 34))"
        )
    }

    private static func providerName(for feedItem: CodexThreadFeedItem) -> String {
        switch feedItem.source {
        case .thread(let thread):
            return thread.provider.displayName
        case .pendingJob(let job):
            return job.provider.displayName
        }
    }

    private static func countPhrase(_ count: Int, singular: String, plural: String) -> String {
        "\(count) \(count == 1 ? singular : plural)"
    }

    private static func shortened(_ value: String, limit: Int) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > limit else { return trimmed }
        return "\(trimmed.prefix(limit - 3).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }
}
