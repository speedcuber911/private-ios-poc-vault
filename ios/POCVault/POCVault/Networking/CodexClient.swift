import Foundation

enum CodexClientError: Error, LocalizedError {
    case httpFailure(Int, String?)
    case emptyResponse
    case invalidEndpoint(URL)

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

final class CodexClient: NSObject, URLSessionDelegate {
    let baseURL: URL

    private let identityStore: ClientIdentityStore
    private let encoder = JSONEncoder()
    private let decoder: JSONDecoder = {
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
    }()

    private lazy var session: URLSession = {
        URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }()

    init(baseURL: URL, identityStore: ClientIdentityStore) {
        self.baseURL = baseURL
        self.identityStore = identityStore
        super.init()
    }

    func fetchHealth() async throws -> CodexHealth {
        let data = try await perform(path: "/v1/codex/health")
        guard !data.isEmpty else {
            return CodexHealth(status: "ok")
        }
        return try decoder.decode(CodexHealth.self, from: data)
    }

    func fetchWorkspaces() async throws -> [CodexWorkspace] {
        let data = try await perform(path: "/v1/codex/workspaces")
        return try decoder.decode(CodexListEnvelope<CodexWorkspace>.self, from: data).values
    }

    func fetchJobs(limit: Int = 50) async throws -> [CodexJob] {
        let data = try await perform(path: "/v1/codex/jobs", queryItems: [
            URLQueryItem(name: "limit", value: String(limit))
        ])
        return try decoder.decode(CodexListEnvelope<CodexJob>.self, from: data).values
    }

    func fetchSessions(workspaceID: String? = nil, limit: Int = 50) async throws -> [CodexSession] {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit))
        ]
        if let workspaceID, !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }

        let data = try await perform(path: "/v1/codex/sessions", queryItems: queryItems)
        return try decoder.decode(CodexListEnvelope<CodexSession>.self, from: data).values
    }

    func fetchThreads(workspaceID: String? = nil, limit: Int = 50) async throws -> [CodexThread] {
        var queryItems = [
            URLQueryItem(name: "limit", value: String(limit))
        ]
        if let workspaceID, !workspaceID.isEmpty {
            queryItems.append(URLQueryItem(name: "workspaceId", value: workspaceID))
        }

        let data = try await perform(path: "/v1/codex/threads", queryItems: queryItems)
        return try decoder.decode(CodexListEnvelope<CodexThread>.self, from: data).values
    }

    func createJob(_ request: CodexCreateJobRequest) async throws -> CodexCreateJobResponse {
        let data = try encoder.encode(request)
        let responseData = try await perform(path: "/v1/codex/jobs", method: "POST", body: data)
        guard !responseData.isEmpty else {
            throw CodexClientError.emptyResponse
        }
        return try decoder.decode(CodexCreateJobResponse.self, from: responseData)
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

    @discardableResult
    func cancelJob(id: String) async throws -> CodexJob? {
        let data = try await perform(path: "/v1/codex/jobs/\(Self.pathComponent(id))/cancel", method: "POST")
        guard !data.isEmpty else {
            return nil
        }
        return try? decoder.decode(CodexJob.self, from: data)
    }

    private func perform(
        path: String,
        method: String = "GET",
        queryItems: [URLQueryItem] = [],
        body: Data? = nil
    ) async throws -> Data {
        let url = endpoint(path: path, queryItems: queryItems)
        guard url.scheme != nil, url.host != nil else {
            throw CodexClientError.invalidEndpoint(url)
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        if let httpResponse = response as? HTTPURLResponse,
           !(200...299).contains(httpResponse.statusCode) {
            throw CodexClientError.httpFailure(httpResponse.statusCode, Self.errorMessage(from: data))
        }
        return data
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

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }

    private static func errorMessage(from data: Data) -> String? {
        guard !data.isEmpty else { return nil }
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return (json["message"] as? String)
                ?? (json["error"] as? String)
                ?? (json["detail"] as? String)
        }
        return String(data: data, encoding: .utf8)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodClientCertificate:
            if let credential = identityStore.credential() {
                completionHandler(.useCredential, credential)
            } else {
                completionHandler(.performDefaultHandling, nil)
            }
        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

private struct CodexListEnvelope<Element: Decodable>: Decodable {
    let values: [Element]

    init(from decoder: Decoder) throws {
        if let values = try? [Element](from: decoder) {
            self.values = values
            return
        }

        let container = try decoder.container(keyedBy: CodexDynamicCodingKey.self)
        for key in ["items", "data", "results", "workspaces", "jobs", "sessions", "threads"] {
            if let codingKey = CodexDynamicCodingKey(stringValue: key),
               let values = try? container.decode([Element].self, forKey: codingKey) {
                self.values = values
                return
            }
        }

        self.values = []
    }
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
