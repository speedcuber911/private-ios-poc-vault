import Foundation

@MainActor
final class CodexConsoleViewModel: ObservableObject {
    @Published private(set) var health: CodexHealth?
    @Published private(set) var workspaces: [CodexWorkspace] = []
    @Published private(set) var sessions: [CodexSession] = []
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var isCreating = false
    @Published private(set) var cancellingJobIDs: Set<String> = []
    @Published private(set) var lastRefreshedAt: Date?
    @Published var selectedWorkspaceID: String? {
        didSet {
            guard selectedWorkspaceID != oldValue else { return }
            clearSelectedSessionIfNeeded()
        }
    }
    @Published var selectedSessionID: String?
    @Published var prompt = ""
    @Published var timeoutMs = 600_000
    @Published var selectedModel = "gpt-5.5"
    @Published var selectedReasoningEffort: CodexReasoningEffort = .xhigh
    @Published private(set) var selectedSkills: [CodexSkill] = []
    @Published var errorMessage: String?

    private let client: CodexClient
    private var hasBootstrapped = false

    init(client: CodexClient) {
        self.client = client
    }

    nonisolated static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }
        if let urlError = error as? URLError, urlError.code == .cancelled {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    var endpointDisplay: String {
        guard let host = client.baseURL.host(percentEncoded: false) ?? client.baseURL.host else {
            return client.baseURL.absoluteString
        }
        if let port = client.baseURL.port {
            return "\(host):\(port)"
        }
        return host
    }

    var selectedWorkspace: CodexWorkspace? {
        guard let selectedWorkspaceID else { return nil }
        return workspaces.first { $0.id == selectedWorkspaceID }
    }

    var selectedSession: CodexSession? {
        guard let selectedSessionID else { return nil }
        return sessions.first { $0.id == selectedSessionID }
    }

    var selectedThread: CodexThread? {
        guard let selectedSessionID else { return nil }
        return threads.first { $0.sessionId == selectedSessionID || $0.id == selectedSessionID }
    }

    var sessionsForSelectedWorkspace: [CodexSession] {
        guard let selectedWorkspaceID else { return sessions }
        return sessions.filter { $0.workspaceId == nil || $0.workspaceId == selectedWorkspaceID }
    }

    var threadsForSelectedWorkspace: [CodexThread] {
        guard let selectedWorkspaceID else { return threads }
        return threads.filter { $0.workspaceId == nil || $0.workspaceId == selectedWorkspaceID }
    }

    var composeWorkspaceID: String {
        selectedWorkspaceID
            ?? workspaces.first(where: { $0.id == "poc-vault" })?.id
            ?? workspaces.first(where: { $0.isDefault })?.id
            ?? workspaces.first?.id
            ?? "poc-vault"
    }

    var hasActiveJobs: Bool {
        jobs.contains { $0.status.isActive }
    }

    var selectedSkillIDs: Set<String> {
        Set(selectedSkills.map(\.id))
    }

    func isCancelling(_ jobID: String) -> Bool {
        cancellingJobIDs.contains(jobID)
    }

    func toggleSkill(_ skill: CodexSkill) {
        if let index = selectedSkills.firstIndex(of: skill) {
            selectedSkills.remove(at: index)
        } else {
            selectedSkills.append(skill)
        }
    }

    func removeSkill(_ skill: CodexSkill) {
        selectedSkills.removeAll { $0 == skill }
    }

    func bootstrapIfNeeded() async {
        guard !hasBootstrapped else { return }
        hasBootstrapped = true
        await refreshAll()
    }

    func refreshAll() async {
        isRefreshing = true
        defer { isRefreshing = false }

        async let workspaceRequest = client.fetchWorkspaces()
        async let jobRequest = client.fetchJobs(limit: 50)
        async let sessionRequest = client.fetchSessions(limit: 50)
        async let threadRequest = client.fetchThreads(limit: 50)
        await refreshHealth()

        do {
            let (workspaceResponse, jobResponse) = try await (workspaceRequest, jobRequest)
            let sessionResponse = (try? await sessionRequest) ?? []
            let threadResponse = (try? await threadRequest) ?? []
            workspaces = workspaceResponse
            jobs = Self.sortedJobs(jobResponse)
            sessions = Self.sortedSessions(sessionResponse)
            threads = Self.sortedThreads(threadResponse)
            selectDefaultWorkspaceIfNeeded()
            clearSelectedSessionIfNeeded()
            errorMessage = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refreshJobs() async {
        do {
            jobs = Self.sortedJobs(try await client.fetchJobs(limit: 50))
            errorMessage = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refreshSessions() async {
        do {
            sessions = Self.sortedSessions(try await client.fetchSessions(limit: 50))
            clearSelectedSessionIfNeeded()
            errorMessage = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refreshThreads() async {
        do {
            threads = Self.sortedThreads(try await client.fetchThreads(limit: 50))
            clearSelectedSessionIfNeeded()
            errorMessage = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refreshHealth() async {
        do {
            health = try await client.fetchHealth()
        } catch {
            guard !Self.isCancellation(error) else { return }
            health = CodexHealth(status: "offline", message: error.localizedDescription, isHealthy: false)
        }
    }

    func pollJobsWhileVisible() async {
        while !Task.isCancelled {
            if hasActiveJobs {
                await refreshJobs()
                await refreshSessions()
                await refreshThreads()
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    func loadJob(id: String, includeFullLogs: Bool = false) async throws -> CodexJob {
        let job = try await client.fetchJob(id: id, includeFullLogs: includeFullLogs)
        upsert(job)
        return job
    }

    func createJobFromCompose() async -> String? {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            errorMessage = "Add a prompt before starting a Codex job."
            return nil
        }
        let promptForJob = Self.prompt(trimmedPrompt, applying: selectedSkills)
        let newJobID = await createJob(
            workspaceID: composeWorkspaceID,
            prompt: promptForJob,
            timeoutMs: timeoutMs,
            resumeSessionID: selectedSessionID
        )
        if newJobID != nil {
            prompt = ""
            selectedSkills = []
        }
        return newJobID
    }

    func retry(_ job: CodexJob) async -> String? {
        guard let prompt = job.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else {
            errorMessage = "This job does not include a prompt to retry."
            return nil
        }
        guard let workspaceID = job.workspaceId ?? selectedWorkspaceID ?? workspaces.first?.id else {
            errorMessage = "No workspace is available for retry."
            return nil
        }

        return await createJob(
            workspaceID: workspaceID,
            prompt: prompt,
            timeoutMs: job.timeoutMs ?? timeoutMs,
            resumeSessionID: job.threadSessionId
        )
    }

    func selectSession(_ session: CodexSession) {
        selectedWorkspaceID = session.workspaceId ?? selectedWorkspaceID
        selectedSessionID = session.id
    }

    func selectThread(_ thread: CodexThread) {
        selectedWorkspaceID = thread.workspaceId ?? selectedWorkspaceID
        selectedSessionID = thread.sessionId
    }

    func selectSessionID(_ sessionID: String, workspaceID: String?) {
        if let workspaceID, !workspaceID.isEmpty {
            selectedWorkspaceID = workspaceID
        }
        selectedSessionID = sessionID
    }

    func startNewThread() {
        selectedSessionID = nil
    }

    func createFollowUp(prompt: String, sessionID: String, workspaceID: String?) async -> String? {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            errorMessage = "Add a reply before continuing this thread."
            return nil
        }
        let resolvedWorkspaceID: String
        if let trimmedWorkspaceID = workspaceID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !trimmedWorkspaceID.isEmpty {
            resolvedWorkspaceID = trimmedWorkspaceID
        } else {
            resolvedWorkspaceID = composeWorkspaceID
        }

        return await createJob(
            workspaceID: resolvedWorkspaceID,
            prompt: trimmedPrompt,
            timeoutMs: timeoutMs,
            resumeSessionID: sessionID
        )
    }

    func cancel(id: String) async {
        cancellingJobIDs.insert(id)
        defer { cancellingJobIDs.remove(id) }

        do {
            if let job = try await client.cancelJob(id: id) {
                upsert(job)
            }
            await refreshJobs()
            errorMessage = nil
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func createJob(
        workspaceID: String,
        prompt: String,
        timeoutMs: Int?,
        resumeSessionID: String? = nil
    ) async -> String? {
        isCreating = true
        defer { isCreating = false }

        do {
            let response = try await client.createJob(
                CodexCreateJobRequest(
                    workspaceId: workspaceID,
                    prompt: prompt,
                    timeoutMs: timeoutMs,
                    model: selectedModel,
                    reasoningEffort: selectedReasoningEffort.rawValue,
                    resumeSessionId: resumeSessionID
                )
            )
            if let job = response.job {
                upsert(job)
            } else if let job = try? await client.fetchJob(id: response.id) {
                upsert(job)
            }
            await refreshJobs()
            await refreshSessions()
            await refreshThreads()
            errorMessage = nil
            return response.id
        } catch {
            guard !Self.isCancellation(error) else { return nil }
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func selectDefaultWorkspaceIfNeeded() {
        if let selectedWorkspaceID,
           workspaces.contains(where: { $0.id == selectedWorkspaceID }) {
            return
        }
        selectedWorkspaceID = workspaces.first(where: { $0.id == "poc-vault" })?.id
            ?? workspaces.first(where: { $0.isDefault })?.id
            ?? workspaces.first?.id
    }

    private func clearSelectedSessionIfNeeded() {
        guard let selectedSessionID else { return }
        guard let selectedSession = sessions.first(where: { $0.id == selectedSessionID }) else {
            guard let selectedThread = threads.first(where: { $0.sessionId == selectedSessionID || $0.id == selectedSessionID }) else {
                self.selectedSessionID = nil
                return
            }
            if let selectedWorkspaceID,
               let threadWorkspaceID = selectedThread.workspaceId,
               threadWorkspaceID != selectedWorkspaceID {
                self.selectedSessionID = nil
            }
            return
        }
        if let selectedWorkspaceID,
           let sessionWorkspaceID = selectedSession.workspaceId,
           sessionWorkspaceID != selectedWorkspaceID {
            self.selectedSessionID = nil
        }
    }

    private func upsert(_ job: CodexJob) {
        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
            jobs[index] = job
        } else {
            jobs.insert(job, at: 0)
        }
        jobs = Self.sortedJobs(jobs)
        lastRefreshedAt = Date()
    }

    private static func sortedJobs(_ jobs: [CodexJob]) -> [CodexJob] {
        jobs.sorted {
            ($0.updatedAt ?? $0.createdAt ?? .distantPast) > ($1.updatedAt ?? $1.createdAt ?? .distantPast)
        }
    }

    private static func sortedSessions(_ sessions: [CodexSession]) -> [CodexSession] {
        sessions.sorted {
            ($0.updatedAt ?? $0.timestamp ?? .distantPast) > ($1.updatedAt ?? $1.timestamp ?? .distantPast)
        }
    }

    private static func sortedThreads(_ threads: [CodexThread]) -> [CodexThread] {
        threads.sorted {
            ($0.updatedAt ?? $0.timestamp ?? .distantPast) > ($1.updatedAt ?? $1.timestamp ?? .distantPast)
        }
    }

    private static func prompt(_ prompt: String, applying skills: [CodexSkill]) -> String {
        guard !skills.isEmpty else { return prompt }
        let names = skills.map(\.id).joined(separator: ", ")
        return "Use these Codex skills for this task: \(names).\n\n\(prompt)"
    }
}

struct CodexSkill: Identifiable, Hashable {
    let id: String
    let title: String
    let group: String
    let summary: String

    var searchText: String {
        "\(id) \(title) \(group) \(summary)".lowercased()
    }

    static let all: [CodexSkill] = [
        CodexSkill(id: "poc-vault-deploy", title: "POC deploy", group: "Vault", summary: "Create, host, publish, or deploy vault POCs."),
        CodexSkill(id: "browser", title: "In-app browser", group: "Browser", summary: "Open and test local web targets in Codex."),
        CodexSkill(id: "chrome", title: "Chrome", group: "Browser", summary: "Use logged-in Chrome sessions and existing tabs."),
        CodexSkill(id: "computer-use", title: "Computer use", group: "Desktop", summary: "Operate local Mac apps by clicking and typing."),
        CodexSkill(id: "github:github", title: "GitHub", group: "Code", summary: "Inspect repositories, PRs, issues, and context."),
        CodexSkill(id: "github:gh-address-comments", title: "Address PR comments", group: "Code", summary: "Find and address GitHub review feedback."),
        CodexSkill(id: "github:gh-fix-ci", title: "Fix CI", group: "Code", summary: "Debug failing GitHub Actions checks."),
        CodexSkill(id: "github:yeet", title: "Publish PR", group: "Code", summary: "Commit, push, and open a draft PR."),
        CodexSkill(id: "linear", title: "Linear", group: "Planning", summary: "Read, create, and update Linear issues."),
        CodexSkill(id: "slack:slack", title: "Slack", group: "Comms", summary: "Read Slack context and route Slack work."),
        CodexSkill(id: "slack:slack-outgoing-message", title: "Slack message", group: "Comms", summary: "Draft or send outbound Slack content."),
        CodexSkill(id: "gmail:gmail", title: "Gmail", group: "Comms", summary: "Search, summarize, draft, and triage email."),
        CodexSkill(id: "google-calendar:google-calendar", title: "Calendar", group: "Scheduling", summary: "Inspect availability and manage events."),
        CodexSkill(id: "notion:notion-research-documentation", title: "Notion research", group: "Docs", summary: "Research Notion sources into documentation."),
        CodexSkill(id: "documents:documents", title: "Documents", group: "Artifacts", summary: "Create and edit Word or docx artifacts."),
        CodexSkill(id: "spreadsheets:Spreadsheets", title: "Spreadsheets", group: "Artifacts", summary: "Create, analyze, and format spreadsheet files."),
        CodexSkill(id: "presentations:Presentations", title: "Presentations", group: "Artifacts", summary: "Build and verify slide decks."),
        CodexSkill(id: "pdf", title: "PDF", group: "Artifacts", summary: "Read, render, create, and review PDFs."),
        CodexSkill(id: "imagegen", title: "Image generation", group: "Media", summary: "Generate or edit raster images."),
        CodexSkill(id: "figma", title: "Figma", group: "Design", summary: "Fetch design context and translate Figma nodes."),
        CodexSkill(id: "frontend-skill", title: "Frontend UI", group: "Design", summary: "Build visually strong app and web UI."),
        CodexSkill(id: "ui-ux-pro-max", title: "UI/UX research", group: "Design", summary: "Use UI and UX design intelligence."),
        CodexSkill(id: "human-code-review", title: "Human review wording", group: "Writing", summary: "Make technical feedback sound natural."),
        CodexSkill(id: "openai-docs", title: "OpenAI docs", group: "Research", summary: "Use current official OpenAI API documentation.")
    ]
}
