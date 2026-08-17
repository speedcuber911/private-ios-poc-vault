import Foundation

enum CodexClientError: Error, LocalizedError {
    case httpFailure(Int, String?)
    case emptyResponse
    case invalidEndpoint(URL)

    var statusCode: Int? {
        guard case .httpFailure(let statusCode, _) = self else {
            return nil
        }
        return statusCode
    }

    var errorDescription: String? {
        switch self {
        case .httpFailure(let statusCode, let message):
            if let message, !message.isEmpty {
                return "Codex request failed with HTTP \(statusCode): \(message)"
            }
            return "Codex request failed with HTTP \(statusCode)."
        case .emptyResponse:
            return "Codex returned an empty response."
        case .invalidEndpoint(let url):
            return "Codex endpoint is invalid: \(url.absoluteString)"
        }
    }
}

struct CodexChatMessage: Codable, Hashable {
    let role: String
    let content: String
}

struct CodexChatRequest: Encodable {
    let provider: String
    let model: String
    let threadId: String?
    let messages: [CodexChatMessage]
    let options: CodexModelOptions?
    /// Folder scope for workspace-scoped chat. Encoded only when non-nil (synthesized
    /// Encodable omits nil optionals) so existing global-chat behavior is unchanged.
    let workspaceId: String?

    init(
        provider: String,
        model: String,
        threadId: String?,
        messages: [CodexChatMessage],
        options: CodexModelOptions?,
        workspaceId: String? = nil
    ) {
        self.provider = provider
        self.model = model
        self.threadId = threadId
        self.messages = messages
        self.options = options
        self.workspaceId = workspaceId
    }
}

enum CodexChatEvent: Hashable {
    case meta(threadId: String, model: String?, provider: String?)
    case delta(String)
    case usage(input: Int?, output: Int?)
    case done(String?)
    case error(String)
}

/// Incremental SSE line parser. The decode step is injected so the same accumulation
/// logic serves both the chat stream (`CodexChatEvent`) and the job stream
/// (`CodexJobStreamEvent`). A decode returning nil drops the event (unknown/heartbeat).
struct CodexSSELineParser<Event> {
    private var event = ""
    private var data = ""
    private let decode: (String, String) -> Event?

    init(decode: @escaping (String, String) -> Event?) {
        self.decode = decode
    }

    mutating func ingest(_ line: String) -> [Event] {
        if line.isEmpty {
            return flush()
        }

        if line.hasPrefix("event:") {
            let pending = flush()
            event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
            return pending
        }

        if line.hasPrefix("data:") {
            let payload = String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
            if data.isEmpty {
                data = payload
            } else {
                data += "\n\(payload)"
            }
        }

        return []
    }

    mutating func finish() -> [Event] {
        flush()
    }

    private mutating func flush() -> [Event] {
        guard !event.isEmpty else {
            data = ""
            return []
        }
        let decoded = decode(event, data)
        event = ""
        data = ""
        guard let decoded else { return [] }
        return [decoded]
    }
}

extension CodexSSELineParser where Event == CodexChatEvent {
    /// Chat-stream parser with the original chat decode step.
    init() {
        self.init(decode: { CodexClient.decodeSSE(event: $0, data: $1) })
    }
}

enum CodexDiagnostics {
    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    static func log(_ event: String, fields: [String: String] = [:]) {
        guard let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return
        }

        let url = documentsURL.appendingPathComponent("codex-diagnostics.jsonl")
        var payload = fields
        payload["event"] = event
        payload["timestamp"] = ISO8601DateFormatter().string(from: Date())

        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
              var line = String(data: data, encoding: .utf8) else {
            return
        }
        line.append("\n")

        if FileManager.default.fileExists(atPath: url.path),
           let handle = try? FileHandle(forWritingTo: url) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: Data(line.utf8))
        } else {
            try? Data(line.utf8).write(to: url, options: .atomic)
        }
    }
}

final class CodexClient: NSObject, URLSessionDelegate, URLSessionTaskDelegate {
    /// The node this client talks to. Mutable so adopting a trial machine can
    /// repoint every store that already holds this client (chat, status feed,
    /// browser) without rebuilding them and losing in-flight state; guarded by a
    /// lock because requests are issued from arbitrary tasks.
    var baseURL: URL {
        baseURLLock.lock()
        defer { baseURLLock.unlock() }
        return storedBaseURL
    }

    private var storedBaseURL: URL
    private let baseURLLock = NSLock()
    private let identityStore: ClientIdentityStore
    private let encoder = JSONEncoder()
    private let decoder = CodexClient.makeDecoder()

    /// The exact decoder every node response goes through. Exposed so tests can
    /// decode fixtures the way the client will, instead of keeping a second
    /// configuration that can silently drift from this one.
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let seconds = try? container.decode(Double.self) {
                return Date(timeIntervalSince1970: seconds)
            }

            let value = try container.decode(String.self)
            if let date = CodexClientDateParser.parse(value) {
                return date
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO-8601 date, got \(value)."
            )
        }
        return decoder
    }

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        // TLS 1.2 ceiling, and it is mTLS that needs it — not a downgrade for
        // its own sake.
        //
        // A trial machine requires a client certificate. Against TLS 1.3 the
        // phone held exactly the right identity (`trial-device`, issued by the
        // CA the machine names as its only acceptable one) and URLSession never
        // asked for it: the ONLY challenge delivered was
        // NSURLAuthenticationMethodServerTrust, and the handshake then died
        // with -1200 — the same failure the machine gives a client that sends
        // no certificate at all (verified against it: no certificate resets
        // immediately, a wrong-CA certificate hangs; the phone reset in ~1s).
        //
        // The difference is where the certificate request sits in the
        // handshake. In TLS 1.2 it arrives before the server is done, so
        // URLSession has a point at which it can ask the delegate. In TLS 1.3
        // it arrives in the server's final flight and the client must answer
        // straight away — and no client-certificate challenge is raised.
        //
        // TLS 1.2 with a pinned CA and a required client certificate is what
        // this app has always used against a personal install; the security
        // property is unchanged, and mTLS is still enforced by the machine.
        // No TLS ceiling. One was set while chasing the missing
        // client-certificate challenge, on the theory that TLS 1.3 delivers
        // the certificate request too late for URLSession to ask the delegate.
        // That was wrong — the challenge was suppressed by answering server
        // trust with `.useCredential`, not by the protocol version — so the
        // cap fixed nothing and left a constraint nobody had reason to want.
        // URLSession's 60-second default is far too long for a machine that is
        // simply not there. Losing a trial (sign-out, or the server answering
        // `no_trial`) reverts the app to the personal install's configured base
        // URL — which for a trial-only user can be a host that no longer
        // exists. That produced a spinner that sat for a full minute before
        // saying "the request timed out", with no indication of which machine
        // was being waited on. Fifteen seconds is well past a slow mobile
        // round-trip to a live node and short enough to report rather than
        // hang. `timeoutIntervalForResource` still bounds long file listings.
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 60
        // Needed so `registerClientCredential` has somewhere to put the
        // identity that this session will actually consult. An ephemeral
        // configuration gets its own private store, which nothing outside the
        // session can reach, and `session.configuration` hands back a copy —
        // so a credential registered after the session exists would go
        // nowhere.
        configuration.urlCredentialStorage = URLCredentialStorage.shared
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    init(baseURL: URL, identityStore: ClientIdentityStore) {
        self.storedBaseURL = baseURL
        self.identityStore = identityStore
        super.init()
        CodexDiagnostics.log("codex_client_init", fields: [
            "baseURL": baseURL.absoluteString,
            "hasClientIdentity": String(identityStore.hasStoredIdentity)
        ])
        registerClientCredential(for: baseURL)
    }

    /// Pre-registers the client identity for a machine, instead of waiting to
    /// be asked for it.
    ///
    /// A trial machine requires a client certificate, and against one iOS never
    /// raises `NSURLAuthenticationMethodClientCertificate` at all: the only
    /// challenge delivered is the server-trust one, and once that is answered
    /// with `.useCredential` — which pinning a private CA requires — the
    /// handshake ends with -1200, the machine's signature for a client that
    /// sent no certificate. The same build against a publicly-trusted host,
    /// where trust is left to `.performDefaultHandling`, does get the
    /// client-certificate challenge. Waiting to be asked therefore cannot work
    /// wherever the CA is pinned.
    ///
    /// A default credential on the protection space is the supported way to
    /// supply one unprompted. The challenge handler stays exactly as it is:
    /// it remains correct for hosts that do ask, and this is scoped to one
    /// host and port, so no other server can be handed this identity.
    private func registerClientCredential(for baseURL: URL) {
        guard let host = baseURL.host, let credential = identityStore.credential() else {
            CodexDiagnostics.log("codex_client_credential_registration", fields: [
                "host": baseURL.host ?? "",
                "registered": "false"
            ])
            return
        }
        let port = baseURL.port ?? (baseURL.scheme == "http" ? 80 : 443)
        let space = URLProtectionSpace(
            host: host,
            port: port,
            protocol: baseURL.scheme,
            realm: nil,
            authenticationMethod: NSURLAuthenticationMethodClientCertificate
        )
        URLCredentialStorage.shared.setDefaultCredential(credential, for: space)
        CodexDiagnostics.log("codex_client_credential_registration", fields: [
            "host": host,
            "port": String(port),
            "registered": "true",
            "identity": identityStore.storedIdentityDescription
        ])
    }

    /// Repoints this client at another node (trial adoption, or reverting to the
    /// personal install when a trial is deleted). The `URLSession` is kept: it is
    /// ephemeral and per-host, so nothing from the previous node leaks into the
    /// new one, and no store holding this client has to be rebuilt.
    func retarget(baseURL: URL) {
        baseURLLock.lock()
        let didChange = storedBaseURL != baseURL
        storedBaseURL = baseURL
        baseURLLock.unlock()

        guard didChange else { return }
        CodexDiagnostics.log("codex_client_retarget", fields: [
            "baseURL": baseURL.absoluteString
        ])
        registerClientCredential(for: baseURL)
    }

    var hasClientIdentity: Bool {
        identityStore.hasStoredIdentity
    }

    func fetchModels() async throws -> [CodexModelDescriptor] {
        let data = try await perform(path: "/v1/codex/models")
        return try decoder.decode(CodexListEnvelope<CodexModelDescriptor>.self, from: data).values
    }

    /// Provider installation and authentication state from the linked computer.
    /// relayd evaluates this under the same HOME/CODEX_HOME used for real tasks.
    func fetchHarnesses() async throws -> [RelayHarnessStatus] {
        let data = try await perform(path: "/v1/harness")
        return try decoder.decode(CodexListEnvelope<RelayHarnessStatus>.self, from: data).values
    }

    /// Discover the skills actually installed for one harness on the linked computer.
    /// The endpoint is provider-scoped so a Claude skill can never leak into a Codex run
    /// (or vice versa), and the returned descriptor contains no runner-local paths.
    func fetchSkills(provider: CodexProvider, workspaceID: String? = nil) async throws -> [CodexSkillDescriptor] {
        var queryItems = [URLQueryItem(name: "provider", value: provider.rawValue)]
        if let workspaceID = workspaceID?.trimmingCharacters(in: .whitespacesAndNewlines), !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }
        let data = try await perform(
            path: "/v1/codex/skills",
            queryItems: queryItems
        )
        return try decoder.decode(CodexListEnvelope<CodexSkillDescriptor>.self, from: data).values
    }

    func fetchWorkspaceDirectories(path: String? = nil, query: String? = nil) async throws -> CodexWorkspaceDirectoryListing {
        var queryItems: [URLQueryItem] = []
        if let path = path?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            queryItems.append(URLQueryItem(name: "path", value: path))
        }
        if let query = query?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty {
            queryItems.append(URLQueryItem(name: "q", value: query))
        }

        let data = try await perform(path: "/v1/codex/workspace-dirs", queryItems: queryItems)
        return try decoder.decode(CodexWorkspaceDirectoryListing.self, from: data)
    }

    /// Bounded listing of one directory in the workspace jail (`GET /v1/codex/fs/list`).
    /// Returns dirs first then files, with pagination metadata (`offset`/`limit`/`total`/`truncated`).
    func fetchDirectory(path: String? = nil, offset: Int? = nil, limit: Int? = nil) async throws -> CodexWorkspaceDirectoryListing {
        var queryItems: [URLQueryItem] = []
        if let path = path?.trimmingCharacters(in: .whitespacesAndNewlines), !path.isEmpty {
            queryItems.append(URLQueryItem(name: "path", value: path))
        }
        if let offset {
            queryItems.append(URLQueryItem(name: "offset", value: String(offset)))
        }
        if let limit {
            queryItems.append(URLQueryItem(name: "limit", value: String(limit)))
        }

        let data = try await perform(path: "/v1/codex/fs/list", queryItems: queryItems)
        return try decoder.decode(CodexWorkspaceDirectoryListing.self, from: data)
    }

    /// Raw bytes of one file in the workspace jail (`GET /v1/codex/fs/file`), optionally a
    /// byte range. `truncated` comes from the 206 status / `Content-Range` response header,
    /// never from byte-count inference.
    func fetchFile(
        path: String,
        range: ClosedRange<Int64>? = nil
    ) async throws -> (data: Data, contentType: String?, truncated: Bool) {
        var headers: [String: String] = [:]
        if let range {
            headers["Range"] = "bytes=\(range.lowerBound)-\(range.upperBound)"
        }

        let (data, response) = try await performWithResponse(
            path: "/v1/codex/fs/file",
            queryItems: [URLQueryItem(name: "path", value: path)],
            accept: "*/*",
            additionalHeaders: headers
        )

        let contentType = response.value(forHTTPHeaderField: "Content-Type")?.trimmedNonEmpty
        let truncated = response.statusCode == 206
            || response.value(forHTTPHeaderField: "Content-Range")?.trimmedNonEmpty != nil
        return (data, contentType, truncated)
    }

    /// Absolute URL of the raw-file endpoint for one jail file, used when a document is
    /// rendered by the authenticated web view (PDF/HTML) instead of fetched as bytes.
    /// Same `/v1/codex/fs/file` route as `fetchFile`; the web view supplies the client
    /// identity through its own certificate-challenge handler.
    func fileWebViewURL(path: String) -> URL? {
        let url = endpoint(
            path: "/v1/codex/fs/file",
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
        guard url.scheme != nil, url.host != nil else { return nil }
        return url
    }

    func selectWorkspace(path: String) async throws -> CodexWorkspace {
        let body = try encoder.encode(CodexSelectWorkspaceRequest(path: path))
        let data = try await perform(path: "/v1/codex/workspaces/select", method: "POST", body: body)
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexWorkspace.self, from: data)
    }

    func createWorkspace(parentPath: String, name: String) async throws -> CodexWorkspace {
        let body = try encoder.encode(CodexCreateWorkspaceRequest(parentPath: parentPath, name: name))
        let data = try await perform(path: "/v1/codex/workspaces/create", method: "POST", body: body)
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexWorkspace.self, from: data)
    }

    func fetchJobs(provider: CodexProvider? = nil, workspaceID: String? = nil, limit: Int = 50) async throws -> [CodexJob] {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit))
        ]
        if let workspaceID, !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }
        appendProvider(provider, to: &queryItems)

        let data = try await perform(path: "/v1/codex/jobs", queryItems: queryItems)
        return try decoder.decode(CodexListEnvelope<CodexJob>.self, from: data).values
    }

    func fetchThreads(provider: CodexProvider? = nil, workspaceID: String? = nil, limit: Int = 50) async throws -> [CodexThread] {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit))
        ]
        if let workspaceID, !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }
        appendProvider(provider, to: &queryItems)

        let data = try await perform(path: "/v1/codex/threads", queryItems: queryItems)
        return try decoder.decode(CodexListEnvelope<CodexThread>.self, from: data).values
    }

    func fetchThreadDetail(
        sessionID: String,
        workspaceID: String? = nil,
        provider: CodexProvider? = nil
    ) async throws -> CodexThreadDetail {
        var queryItems: [URLQueryItem] = []
        if let workspaceID, !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }
        appendProvider(provider, to: &queryItems)

        let data = try await perform(path: "/v1/codex/threads/\(Self.pathComponent(sessionID))", queryItems: queryItems)
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexThreadDetail.self, from: data)
    }

    func deleteThread(sessionID: String, workspaceID: String?, provider: CodexProvider? = nil) async throws {
        var queryItems: [URLQueryItem] = []
        if let workspaceID, !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }
        appendProvider(provider, to: &queryItems)

        _ = try await perform(
            path: "/v1/codex/threads/\(Self.pathComponent(sessionID))",
            method: "DELETE",
            queryItems: queryItems
        )
    }

    func createJob(_ request: CodexCreateJobRequest) async throws -> CodexCreateJobResponse {
        let data = try encoder.encode(request)
        let responseData = try await perform(path: "/v1/codex/jobs", method: "POST", body: data)
        guard !responseData.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexCreateJobResponse.self, from: responseData)
    }

    func fetchApprovals(jobID: String? = nil, pendingOnly: Bool = false) async throws -> [CodexApproval] {
        var query: [URLQueryItem] = []
        if let jobID { query.append(URLQueryItem(name: "jobId", value: jobID)) }
        if pendingOnly { query.append(URLQueryItem(name: "status", value: "pending")) }
        let data = try await perform(path: "/v1/codex/approvals", queryItems: query)
        return try decoder.decode(CodexListEnvelope<CodexApproval>.self, from: data).values
    }

    func decideApproval(id: String, decision: CodexApprovalDecision, message: String? = nil) async throws -> CodexApproval {
        var payload: [String: String] = ["decision": decision.rawValue]
        if let message { payload["message"] = message }
        let data = try await perform(
            path: "/v1/codex/approvals/\(Self.pathComponent(id))/decision",
            method: "POST",
            body: try JSONEncoder().encode(payload)
        )
        return try decoder.decode(CodexApprovalEnvelope.self, from: data).approval
    }

    func decideFirstPendingApproval(jobID: String, decision: CodexApprovalDecision) async throws {
        guard let approval = try await fetchApprovals(jobID: jobID, pendingOnly: true).first else { return }
        _ = try await decideApproval(id: approval.id, decision: decision)
    }

    func createTerminal(workspaceID: String, cols: Int = 80, rows: Int = 24) async throws -> CodexTerminal {
        let body = try JSONSerialization.data(withJSONObject: ["workspaceId": workspaceID, "cols": cols, "rows": rows])
        let data = try await perform(path: "/v1/codex/terminals", method: "POST", body: body)
        return try decoder.decode(CodexTerminalEnvelope.self, from: data).terminal
    }

    func sendTerminalInput(id: String, text: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["text": text])
        _ = try await perform(path: "/v1/codex/terminals/\(Self.pathComponent(id))/input", method: "POST", body: body)
    }

    func closeTerminal(id: String) async throws {
        _ = try await perform(path: "/v1/codex/terminals/\(Self.pathComponent(id))/close", method: "POST", body: Data("{}".utf8))
    }

    func terminalEvents(id: String) -> AsyncThrowingStream<CodexTerminalStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let url = endpoint(path: "/v1/codex/terminals/\(Self.pathComponent(id))/stream", queryItems: [])
                    var request = URLRequest(url: url)
                    applyDeviceToken(to: &request, url: url)
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
                        throw CodexClientError.httpFailure((response as? HTTPURLResponse)?.statusCode ?? 0, nil)
                    }
                    var event = ""
                    var data = ""
                    for try await line in bytes.lines {
                        if Task.isCancelled { break }
                        if line.isEmpty {
                            if let decoded = Self.decodeTerminalEvent(event: event, data: data) { continuation.yield(decoded) }
                            event = ""; data = ""
                        } else if line.hasPrefix("event:") {
                            event = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            data += String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces)
                        }
                    }
                    continuation.finish()
                } catch { continuation.finish(throwing: error) }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func decodeTerminalEvent(event: String, data: String) -> CodexTerminalStreamEvent? {
        guard let payload = try? JSONSerialization.jsonObject(with: Data(data.utf8)) as? [String: Any] else { return nil }
        if event == "output", let text = payload["text"] as? String { return .output(text) }
        let decoder = makeDecoder()
        if event == "snapshot", let output = payload["output"] as? String,
           let terminal = payload["terminal"], let bytes = try? JSONSerialization.data(withJSONObject: terminal),
           let decoded = try? decoder.decode(CodexTerminal.self, from: bytes) { return .snapshot(terminal: decoded, output: output) }
        if event == "done", let terminal = payload["terminal"], let bytes = try? JSONSerialization.data(withJSONObject: terminal),
           let decoded = try? decoder.decode(CodexTerminal.self, from: bytes) { return .done(decoded) }
        return nil
    }

    func fetchJob(id: String, includeFullLogs: Bool = false) async throws -> CodexJob {
        let data = try await perform(
            path: "/v1/codex/jobs/\(Self.pathComponent(id))",
            queryItems: includeFullLogs ? [URLQueryItem(name: "include", value: "fullLogs")] : []
        )
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexJob.self, from: data)
    }

    func resolvedArtifactURL(_ value: String?) -> URL? {
        Self.resolvedArtifactURL(value, baseURL: baseURL)
    }

    static func resolvedArtifactURL(_ value: String?, baseURL: URL) -> URL? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        let candidate: URL?
        if let absolute = URL(string: value), absolute.scheme != nil {
            candidate = absolute
        } else if var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) {
            components.path = value.hasPrefix("/") ? value : "/\(value)"
            components.query = nil
            components.fragment = nil
            candidate = components.url
        } else {
            candidate = URL(string: value, relativeTo: baseURL)?.absoluteURL
        }

        guard let candidate, isTrustedArtifactURL(candidate, baseURL: baseURL) else {
            return nil
        }
        return candidate
    }

    /// Job artifact URLs are server-authored capabilities. Keep them on the configured
    /// Relay origin and on the exact artifact route so a compromised/malformed job cannot
    /// turn the authenticated client or WebView into a fetcher for another host.
    static func isTrustedArtifactURL(_ url: URL, baseURL: URL) -> Bool {
        guard
            url.scheme?.lowercased() == baseURL.scheme?.lowercased(),
            url.host?.lowercased() == baseURL.host?.lowercased(),
            effectivePort(for: url) == effectivePort(for: baseURL),
            url.user == nil,
            url.password == nil,
            url.query == nil,
            url.fragment == nil
        else {
            return false
        }

        let parts = url.pathComponents.filter { $0 != "/" }
        return parts.count == 7
            && parts[0] == "v1"
            && parts[1] == "codex"
            && parts[2] == "jobs"
            && !parts[3].isEmpty
            && parts[4] == "artifacts"
            && !parts[5].isEmpty
            && (parts[6] == "raw" || parts[6] == "preview")
    }

    private static func effectivePort(for url: URL) -> Int? {
        if let port = url.port { return port }
        switch url.scheme?.lowercased() {
        case "https": return 443
        case "http": return 80
        default: return nil
        }
    }

    /// Fetches artifact bytes through the same pinned/mTLS or device-token session as the
    /// rest of Relay. The URL must first pass `isTrustedArtifactURL` above.
    func fetchArtifact(_ value: String?) async throws -> (data: Data, contentType: String?) {
        guard let url = resolvedArtifactURL(value) else {
            throw CodexClientError.invalidEndpoint(baseURL)
        }
        let (data, response) = try await performWithResponse(
            path: url.path,
            accept: "*/*"
        )
        return (
            data,
            response.value(forHTTPHeaderField: "Content-Type")?.trimmedNonEmpty
        )
    }

    /// Turns a localhost URL returned by one job into a short-lived preview URL on
    /// the linked machine. The returned URL stays on the configured Relay origin;
    /// relayd owns the loopback hop and never asks the phone to resolve localhost.
    func createPreview(jobID: String, sourceURL: URL) async throws -> (lease: CodexPreviewLease, url: URL) {
        let body = try encoder.encode(CodexCreatePreviewRequest(
            jobId: jobID,
            url: sourceURL.absoluteString
        ))
        let data = try await perform(path: "/v1/codex/previews", method: "POST", body: body)
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        let lease = try decoder.decode(CodexPreviewLease.self, from: data)
        guard let url = resolvedPreviewURL(lease.url) else {
            throw CodexClientError.invalidEndpoint(baseURL)
        }
        return (lease, url)
    }

    func resolvedPreviewURL(_ value: String?) -> URL? {
        Self.resolvedPreviewURL(value, baseURL: baseURL)
    }

    static func resolvedPreviewURL(_ value: String?, baseURL: URL) -> URL? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
            return nil
        }
        let candidate: URL?
        if let absolute = URL(string: value), absolute.scheme != nil {
            candidate = absolute
        } else if var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) {
            components.path = value.hasPrefix("/") ? value : "/\(value)"
            components.query = nil
            components.fragment = nil
            candidate = components.url
        } else {
            candidate = URL(string: value, relativeTo: baseURL)?.absoluteURL
        }

        guard let candidate,
              candidate.scheme?.lowercased() == baseURL.scheme?.lowercased(),
              candidate.host?.lowercased() == baseURL.host?.lowercased(),
              Self.effectivePort(for: candidate) == Self.effectivePort(for: baseURL),
              candidate.user == nil,
              candidate.password == nil,
              candidate.query == nil,
              candidate.fragment == nil else {
            return nil
        }
        let parts = candidate.pathComponents.filter { $0 != "/" }
        guard parts.count == 4,
              parts[0] == "v1",
              parts[1] == "codex",
              parts[2] == "previews",
              parts[3].range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            return nil
        }
        return candidate
    }

    @discardableResult
    func cancelJob(id: String) async throws -> CodexJob? {
        let data = try await perform(path: "/v1/codex/jobs/\(Self.pathComponent(id))/cancel", method: "POST")
        guard !data.isEmpty else {
            return nil
        }
        return try? decoder.decode(CodexJob.self, from: data)
    }

    // MARK: - Handoffs

    /// Sessions handed over from a Mac (`GET /v1/handoffs` → `{handoffs: [...]}`).
    /// The list projection carries no manifest and never the primed prompt.
    func fetchHandoffs() async throws -> [RelayHandoffCard] {
        let data = try await perform(path: "/v1/handoffs")
        return try decoder.decode(CodexListEnvelope<RelayHandoffCard>.self, from: data).values
    }

    /// One handoff with the manifest relayd decrypted on the node
    /// (`GET /v1/handoffs/:id` → `{handoff: {...}}`). An unknown or malformed id
    /// is a clean 404 from the node, surfaced here as `httpFailure(404, _)`.
    func fetchHandoff(id: String) async throws -> RelayHandoffDetail {
        let data = try await perform(path: "/v1/handoffs/\(Self.pathComponent(id))")
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(RelayHandoffEnvelope.self, from: data).handoff
    }

    /// Resumes the handed-off session as an ordinary job in its worktree
    /// (`POST /v1/handoffs/:id/continue` → 202 `{job: {...}}`), so its output
    /// streams over the existing job SSE. 409 when the handoff is not ready or
    /// already has a job running.
    func continueHandoff(id: String, prompt: String? = nil) async throws -> CodexCreateJobResponse {
        var body: [String: String] = [:]
        if let prompt = prompt?.trimmedNonEmpty {
            body["prompt"] = prompt
        }
        let data = try await perform(
            path: "/v1/handoffs/\(Self.pathComponent(id))/continue",
            method: "POST",
            body: try JSONSerialization.data(withJSONObject: body)
        )
        guard !data.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexCreateJobResponse.self, from: data)
    }

    /// The "On your Mac" index (`GET /v1/mac-sessions` → `{index: ... | null}`).
    /// Metadata only; nil when no Mac has ever published one.
    func fetchMacSessions() async throws -> RelayMacSessionIndex? {
        let data = try await perform(path: "/v1/mac-sessions")
        guard !data.isEmpty else { return nil }
        return try decoder.decode(RelayMacSessionEnvelope.self, from: data).index
    }

    func transcribeAudio(fileURL: URL) async throws -> CodexTranscriptionResponse {
        let data = try Data(contentsOf: fileURL)
        return try await transcribeAudio(
            data: data,
            filename: fileURL.lastPathComponent.isEmpty ? "phone-prompt.wav" : fileURL.lastPathComponent,
            contentType: "audio/wav"
        )
    }

    func transcribeAudio(data: Data, filename: String, contentType: String) async throws -> CodexTranscriptionResponse {
        let responseData = try await perform(
            path: "/v1/codex/transcriptions",
            method: "POST",
            body: data,
            contentType: contentType,
            additionalHeaders: ["X-Audio-Filename": filename]
        )
        guard !responseData.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexTranscriptionResponse.self, from: responseData)
    }

    func streamChat(_ body: CodexChatRequest) -> AsyncThrowingStream<CodexChatEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let url = endpoint(path: "/v1/codex/chat", queryItems: [])
                    guard url.scheme != nil, url.host != nil else {
                        throw CodexClientError.invalidEndpoint(url)
                    }

                    var request = URLRequest(url: url)
                    applyDeviceToken(to: &request, url: url)
                    request.httpMethod = "POST"
                    request.timeoutInterval = 300
                    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    request.httpBody = try encoder.encode(body)

                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw CodexClientError.emptyResponse
                    }
                    guard (200...299).contains(http.statusCode) else {
                        let message = try await Self.errorMessage(from: bytes)
                        throw CodexClientError.httpFailure(http.statusCode, message)
                    }

                    CodexDiagnostics.log("codex_stream_response_success", fields: [
                        "path": "/v1/codex/chat",
                        "url": url.absoluteString,
                        "status": String(http.statusCode)
                    ])

                    var parser = CodexSSELineParser()
                    for try await line in bytes.lines {
                        for event in parser.ingest(line.trimmingCharacters(in: .newlines)) {
                            continuation.yield(event)
                            if event.isTerminalChatEvent {
                                continuation.finish()
                                return
                            }
                        }
                    }
                    for event in parser.finish() {
                        continuation.yield(event)
                        if event.isTerminalChatEvent {
                            continuation.finish()
                            return
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Live job SSE (`GET /v1/codex/jobs/<id>/stream`): status snapshots, stdout/stderr
    /// chunks from the requested offsets, then the terminal `done` job. The stream finishes
    /// after `done`; cancelling the consuming task aborts the request (mTLS handled by the
    /// shared session delegate).
    func streamJobEvents(
        id: String,
        stdoutOffset: Int64? = nil,
        stderrOffset: Int64? = nil
    ) -> AsyncThrowingStream<CodexJobStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var queryItems: [URLQueryItem] = []
                    if let stdoutOffset {
                        queryItems.append(URLQueryItem(name: "stdoutOffset", value: String(stdoutOffset)))
                    }
                    if let stderrOffset {
                        queryItems.append(URLQueryItem(name: "stderrOffset", value: String(stderrOffset)))
                    }

                    let path = "/v1/codex/jobs/\(Self.pathComponent(id))/stream"
                    let url = endpoint(path: path, queryItems: queryItems)
                    guard url.scheme != nil, url.host != nil else {
                        throw CodexClientError.invalidEndpoint(url)
                    }

                    var request = URLRequest(url: url)
                    applyDeviceToken(to: &request, url: url)
                    request.httpMethod = "GET"
                    request.timeoutInterval = 300
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                    let (bytes, response) = try await session.bytes(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        throw CodexClientError.emptyResponse
                    }
                    guard (200...299).contains(http.statusCode) else {
                        let message = try await Self.errorMessage(from: bytes)
                        throw CodexClientError.httpFailure(http.statusCode, message)
                    }

                    CodexDiagnostics.log("codex_stream_response_success", fields: [
                        "path": path,
                        "url": url.absoluteString,
                        "status": String(http.statusCode)
                    ])

                    var parser = CodexSSELineParser<CodexJobStreamEvent> { event, data in
                        CodexJobStreamEvent.decode(event: event, data: data)
                    }
                    for try await line in bytes.lines {
                        for event in parser.ingest(line.trimmingCharacters(in: .newlines)) {
                            continuation.yield(event)
                            if case .done = event {
                                continuation.finish()
                                return
                            }
                        }
                    }
                    for event in parser.finish() {
                        continuation.yield(event)
                        if case .done = event {
                            continuation.finish()
                            return
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    private static func errorMessage(from bytes: URLSession.AsyncBytes) async throws -> String? {
        var body = ""
        for try await line in bytes.lines {
            body += line
            body += "\n"
            if body.count >= 2_048 {
                break
            }
        }
        return errorMessage(from: Data(body.utf8))
    }

    private func perform(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String = "application/json",
        additionalHeaders: [String: String] = [:]
    ) async throws -> Data {
        try await performWithResponse(
            path: path,
            method: method,
            queryItems: queryItems,
            body: body,
            contentType: contentType,
            additionalHeaders: additionalHeaders
        ).data
    }

    /// Same as `perform`, but also surfaces the HTTPURLResponse so callers can read
    /// status/headers (e.g. 206 + Content-Range on `/v1/codex/fs/file`).
    private func performWithResponse(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: Data? = nil,
        contentType: String = "application/json",
        accept: String = "application/json",
        additionalHeaders: [String: String] = [:]
    ) async throws -> (data: Data, response: HTTPURLResponse) {
        let url = endpoint(path: path, queryItems: queryItems)
        guard url.scheme != nil, url.host != nil else {
            throw CodexClientError.invalidEndpoint(url)
        }

        CodexDiagnostics.log("codex_request_start", fields: [
            "method": method,
            "path": path,
            "url": url.absoluteString,
            "hasClientIdentity": String(identityStore.hasStoredIdentity)
        ])

        var request = URLRequest(url: url)
        applyDeviceToken(to: &request, url: url)
        request.httpMethod = method
        request.timeoutInterval = 45
        request.setValue(accept, forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        }
        for (field, value) in additionalHeaders {
            request.setValue(value, forHTTPHeaderField: field)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            let nsError = error as NSError
            // NSURLErrorDomain -1200 is the same opaque code for every TLS
            // failure. The underlying error carries the actual OSStatus (a
            // handshake abort and a rejected client certificate are different
            // numbers), and the identity description says what we would have
            // offered had iOS asked — together they separate "we sent the wrong
            // certificate" from "we were never asked for one".
            let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError
            CodexDiagnostics.log("codex_request_error", fields: [
                "method": method,
                "path": path,
                "url": url.absoluteString,
                "domain": nsError.domain,
                "code": String(nsError.code),
                "description": error.localizedDescription,
                "hasClientIdentity": String(identityStore.hasStoredIdentity),
                "underlyingDomain": underlying?.domain ?? "",
                "underlyingCode": underlying.map { String($0.code) } ?? "",
                "identity": identityStore.storedIdentityDescription
            ])
            throw error
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw CodexClientError.emptyResponse
        }

        if !(200...299).contains(httpResponse.statusCode) {
            CodexDiagnostics.log("codex_response_http_failure", fields: [
                "method": method,
                "path": path,
                "url": url.absoluteString,
                "status": String(httpResponse.statusCode),
                "body": Self.errorMessage(from: data) ?? ""
            ])
            throw CodexClientError.httpFailure(httpResponse.statusCode, Self.errorMessage(from: data))
        }
        CodexDiagnostics.log("codex_response_success", fields: [
            "method": method,
            "path": path,
            "url": url.absoluteString,
            "status": String(httpResponse.statusCode),
            "bytes": String(data.count)
        ])
        return (data, httpResponse)
    }

    /// Downloads the node's whole workspace jail as a tar and returns a local
    /// file URL for sharing. Streamed to disk rather than held in memory: a
    /// trial machine's jail can be far larger than an iPhone will tolerate as
    /// a single `Data`. The caller owns the returned file.
    func downloadExport() async throws -> URL {
        let url = endpoint(path: "/v1/export.tar", queryItems: [])
        var request = URLRequest(url: url)
        applyDeviceToken(to: &request, url: url)
        request.httpMethod = "GET"
        request.timeoutInterval = 600
        request.setValue("application/x-tar", forHTTPHeaderField: "Accept")

        let (temporaryURL, response) = try await session.download(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw CodexClientError.emptyResponse
        }
        guard (200...299).contains(http.statusCode) else {
            try? FileManager.default.removeItem(at: temporaryURL)
            throw CodexClientError.httpFailure(http.statusCode, nil)
        }
        // URLSession deletes its temp file as soon as this call returns, so the
        // payload has to be moved somewhere the share sheet can still read.
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-workspaces.tar")
        try? FileManager.default.removeItem(at: destination)
        try FileManager.default.moveItem(at: temporaryURL, to: destination)
        return destination
    }

    private func endpoint(path: String, queryItems: [URLQueryItem]) -> URL {
        let base = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalizedPath = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let rawURL = "\(base)/\(normalizedPath)"
        guard var components = URLComponents(string: rawURL) else {
            return URL(string: rawURL) ?? baseURL
        }
        if !queryItems.isEmpty {
            components.queryItems = queryItems
        }
        return components.url ?? URL(string: rawURL) ?? baseURL
    }

    private func appendProvider(_ provider: CodexProvider?, to queryItems: inout [URLQueryItem]) {
        guard let provider else { return }
        queryItems.append(URLQueryItem(name: "provider", value: provider.rawValue))
    }

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func errorMessage(from data: Data) -> String? {
        guard !data.isEmpty else { return nil }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return sanitizedErrorMessage((json["message"] as? String)
                ?? (json["error"] as? String)
                ?? (json["detail"] as? String))
        }
        return sanitizedErrorMessage(String(data: data, encoding: .utf8))
    }

    private static func sanitizedErrorMessage(_ message: String?) -> String? {
        guard var cleaned = message?.trimmingCharacters(in: .whitespacesAndNewlines),
              !cleaned.isEmpty else {
            return nil
        }

        if cleaned.localizedCaseInsensitiveContains("<html")
            || cleaned.localizedCaseInsensitiveContains("<body")
            || cleaned.localizedCaseInsensitiveContains("<title") {
            cleaned = firstHTMLText(in: cleaned, tag: "title")
                ?? firstHTMLText(in: cleaned, tag: "h1")
                ?? "Forbidden"
        }

        cleaned = stripHTMLTags(from: cleaned)
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard !cleaned.isEmpty else { return nil }
        if cleaned.count > 240 {
            return "\(cleaned.prefix(237))..."
        }
        return cleaned
    }

    private static func firstHTMLText(in html: String, tag: String) -> String? {
        let pattern = "(?is)<\(tag)[^>]*>(.*?)</\(tag)>"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: html) else {
            return nil
        }
        return stripHTMLTags(from: String(html[range]))
    }

    private static func stripHTMLTags(from text: String) -> String {
        text.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
    }

    static func decodeSSE(event: String, data: String) -> CodexChatEvent {
        let payloadData = Data(data.utf8)
        let payload = (try? JSONSerialization.jsonObject(with: payloadData)) as? [String: Any] ?? [:]
        switch event {
        case "meta":
            return .meta(
                threadId: (payload["threadId"] as? String) ?? "",
                model: payload["model"] as? String,
                provider: payload["provider"] as? String
            )
        case "delta":
            return .delta((payload["text"] as? String) ?? "")
        case "usage":
            return .usage(input: payload["inputTokens"] as? Int, output: payload["outputTokens"] as? Int)
        case "done":
            return .done(payload["stopReason"] as? String)
        case "error":
            return .error((payload["message"] as? String) ?? "Chat failed.")
        default:
            return .error("Unknown chat event: \(event)")
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handleAuthenticationChallenge(challenge, scope: "session", completionHandler: completionHandler)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        handleAuthenticationChallenge(challenge, scope: "task", completionHandler: completionHandler)
    }


    /// Adds the machine's bearer token, when this device has one for that host.
    ///
    /// Trial machines authenticate the device with a token instead of a client
    /// certificate: iOS will not send a certificate to a server whose
    /// certificate it did not itself anchor, and declines silently, so mTLS to
    /// a trial machine cannot complete from the app. The token is scoped to one
    /// host, so no other server ever receives it, and a personal install
    /// continues to authenticate with its certificate untouched.
    private func applyDeviceToken(to request: inout URLRequest, url: URL) {
        guard let host = url.host, let token = identityStore.deviceToken(for: host) else { return }
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }

    private func handleAuthenticationChallenge(
        _ challenge: URLAuthenticationChallenge,
        scope: String,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        // Logged for EVERY challenge, before the switch. A trial machine failed
        // with -1200 after the server-trust challenge succeeded, and the
        // question that could not be answered from the existing events was
        // whether iOS ever asked for a client certificate at all — the
        // per-branch logs below cannot distinguish "not asked" from "asked and
        // we declined". They are still emitted; this one establishes the set.
        CodexDiagnostics.log("codex_auth_challenge_received", fields: [
            "host": challenge.protectionSpace.host,
            "method": challenge.protectionSpace.authenticationMethod,
            "scope": scope,
            "previousFailureCount": String(challenge.previousFailureCount)
        ])

        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodClientCertificate:
            if let credential = identityStore.credential() {
                CodexDiagnostics.log("codex_client_cert_challenge", fields: [
                    "host": challenge.protectionSpace.host,
                    "scope": scope,
                    "hasCredential": "true",
                    // What we are about to hand iOS, and how many CAs the
                    // machine said it would accept. iOS silently declines to
                    // send a certificate it cannot match to that list, and
                    // says nothing about why.
                    "identity": identityStore.storedIdentityDescription,
                    "acceptableCAs": String(challenge.protectionSpace.distinguishedNames?.count ?? -1)
                ])
                completionHandler(.useCredential, credential)
            } else {
                CodexDiagnostics.log("codex_client_cert_challenge", fields: [
                    "host": challenge.protectionSpace.host,
                    "scope": scope,
                    "hasCredential": "false"
                ])
                completionHandler(.performDefaultHandling, nil)
            }
        case NSURLAuthenticationMethodServerTrust:
            // A trial machine's certificate is signed by that node's own CA (the
            // broker is TLS passthrough), so the system trust store can never
            // validate it. Pin the CA that shipped in the pairing PKCS#12 — for
            // that host only; every other host keeps default handling.
            RelayServerTrust.handleServerTrustChallenge(
                challenge,
                identityStore: identityStore,
                scope: scope,
                completionHandler: completionHandler
            )
        default:
            CodexDiagnostics.log("codex_auth_challenge", fields: [
                "host": challenge.protectionSpace.host,
                "method": challenge.protectionSpace.authenticationMethod,
                "scope": scope
            ])
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

private extension CodexChatEvent {
    var isTerminalChatEvent: Bool {
        switch self {
        case .done, .error:
            return true
        case .meta, .delta, .usage:
            return false
        }
    }
}

private struct CodexSelectWorkspaceRequest: Encodable {
    let path: String
}

private struct CodexCreateWorkspaceRequest: Encodable {
    let parentPath: String
    let name: String
}

private struct CodexListEnvelope<Element: Decodable>: Decodable {
    let values: [Element]

    init(from decoder: Decoder) throws {
        if let values = try? [Element](from: decoder) {
            self.values = values
            return
        }

        let container = try decoder.container(keyedBy: CodexDynamicCodingKey.self)
        for key in ["items", "data", "results", "models", "workspaces", "jobs", "sessions", "threads", "handoffs", "skills", "approvals", "terminals", "harnesses"] {
            if let codingKey = CodexDynamicCodingKey(stringValue: key),
               let values = try? container.decode([Element].self, forKey: codingKey) {
                self.values = values
                return
            }
        }

        self.values = []
    }
}

private struct CodexApprovalEnvelope: Decodable { let approval: CodexApproval }
private struct CodexTerminalEnvelope: Decodable { let terminal: CodexTerminal }

private struct RelayHandoffEnvelope: Decodable {
    let handoff: RelayHandoffDetail
}

private struct RelayMacSessionEnvelope: Decodable {
    let index: RelayMacSessionIndex?
}

private struct CodexDynamicCodingKey: CodingKey {
    let stringValue: String
    let intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

private enum CodexClientDateParser {
    static func parse(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let seconds = Double(trimmed) {
            return Date(timeIntervalSince1970: seconds)
        }
        if let date = fractional.date(from: trimmed) {
            return date
        }
        return standard.date(from: trimmed)
    }

    private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
