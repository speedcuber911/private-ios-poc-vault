import Foundation

enum RelayWatchProjection {
    static func update(_ row: inout RelayWatchThread, from timeline: RelayTimeline) {
        let steps = timeline.blocks.flatMap { timeline.steps(in: $0) }
        let progress = RelayTimeline.summary(of: steps)
        let failed = RelayTimeline.failedCount(in: steps)
        row.progress = progress.isEmpty ? nil : progress + (failed > 0 ? ". \(failed) failed." : "")
        // Latest agent prose only. Tool output and reasoning never go to watch.
        if let latest = timeline.blocks.reversed().compactMap({ block -> String? in
            if case .prose(let text) = block.content { return text }
            return nil
        }).first, !latest.isEmpty {
            row.excerpt = RelayWatchText.excerpt(latest)
        }
    }

    static func snapshot(
        sourceID: String, models: [CodexModelDescriptor], folders: [CodexWorkspace],
        threads: [CodexThread], jobs: [CodexJob], approvals: [CodexApproval], now: Date = Date()
    ) -> RelayWatchSnapshot {
        // Direct subscription task models only. A model's API value is resolved
        // on the phone; the watch cannot invent a provider or a workspace path.
        let supportedModels = models.filter { $0.supports(.task) && [.codex, .claude].contains($0.provider) }
        let feed = CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs)
        let rows = feed.compactMap { item -> RelayWatchThread? in
            switch item.source {
            case .thread(let thread):
                guard [.codex, .claude].contains(thread.provider), thread.mode == .task else { return nil }
                return RelayWatchThread(
                    id: item.id, sessionID: thread.sessionId, jobID: thread.lastJobId,
                    workspaceID: thread.workspaceId, provider: thread.provider.rawValue,
                    title: String((CodexThread.threadTitle(from: thread.lastPrompt) ?? thread.workspaceLabel).prefix(80)),
                    status: thread.lastJobStatus?.label ?? "Ready", isActive: thread.hasActiveJobs,
                    excerpt: RelayWatchText.excerpt(thread.lastError ?? thread.lastResult ?? "")
                )
            case .pendingJob(let job):
                guard [.codex, .claude].contains(job.provider) else { return nil }
                return RelayWatchThread(
                    id: item.id, sessionID: job.threadSessionId, jobID: job.id,
                    workspaceID: job.workspaceId, provider: job.provider.rawValue,
                    title: String((CodexThread.threadTitle(from: job.prompt) ?? job.workspaceName ?? "New thread").prefix(80)),
                    status: job.status.label, isActive: job.status.isActive,
                    excerpt: RelayWatchText.excerpt(job.errorMessage ?? job.result ?? "")
                )
            }
        }
        return RelayWatchSnapshot(
            sourceID: sourceID, updatedAt: now,
            models: Array(supportedModels.prefix(30)).map {
                RelayWatchModel(id: $0.id, label: String($0.label.prefix(100)), provider: $0.provider.rawValue, efforts: $0.effortLevels)
            },
            folders: Array(folders.prefix(40)).map { RelayWatchFolder(id: $0.id, name: String($0.name.prefix(100))) },
            threads: Array(rows.prefix(12)),
            approvals: Array(approvals.filter(\.isPending).prefix(4)).map(approval)
        )
    }

    static func approval(_ value: CodexApproval) -> RelayWatchApproval {
        let detail = [value.reason, value.command, value.cwd.map { "Folder: \($0)" }]
            .compactMap { $0 }.joined(separator: "\n\n")
        let tooLong = detail.count > 1_400 || value.title.count > 200
        return RelayWatchApproval(
            id: value.id, jobID: value.jobId, title: String(value.title.prefix(200)),
            detail: tooLong ? RelayWatchText.excerpt(detail, limit: 700) : detail,
            decisions: value.availableDecisions.filter { ["accept", "decline"].contains($0) },
            requiresPhone: tooLong
        )
    }
}
