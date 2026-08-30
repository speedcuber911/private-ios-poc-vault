import Foundation

enum RelayTrialClientError: Error, Equatable {
    case unavailable        // 404 trial_unavailable
    case alreadyUsed        // 409 trial_already_used
    case pairingConflict    // 409 slot_already_written / node_exists / other
    case capacity           // 503
    case provisionFailed    // 502
    case noTrial             // 404 no_trial
    case blobPending        // 404 not_posted_yet
    case tooManyAttempts    // 429 too_many_pairing_sessions
    case tagMismatch
    case reconnectUnavailable
    case machineNotReady
    case hostedAccessUnavailable
    case hostedUpgradeRequired
    case server(status: Int)
}

final class RelayTrialClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func createPairingSession(authToken: String, bearer: String) async throws -> String {
        struct Response: Decodable { let pairingId: String; let expiresAt: Int64 }
        let (data, response) = try await send(
            method: "POST",
            path: "/v1/pairing/sessions",
            body: ["authToken": authToken],
            bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
        return try JSONDecoder().decode(Response.self, from: data).pairingId
    }

    func createTrial(pairingId: String, pairingSecret: String, bearer: String) async throws -> RelayTrialNode {
        let (data, response) = try await send(
            method: "POST",
            path: "/v1/trial-nodes",
            body: ["pairingId": pairingId, "pairingSecret": pairingSecret],
            bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
        return try Self.decodeTrialEnvelope(data)
    }

    func currentTrial(bearer: String) async throws -> RelayTrialNode {
        let (data, response) = try await send(
            method: "GET",
            path: "/v1/trial-nodes/current",
            body: nil,
            bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
        return try Self.decodeTrialEnvelope(data)
    }

    struct HostedPairingSession: Decodable {
        let pairingId: String
        let expiresAt: Int64
    }

    func createHostedPairingSession(authToken: String, bearer: String) async throws -> HostedPairingSession {
        let (data, response) = try await send(
            method: "POST",
            path: "/v1/pairing/sessions",
            body: ["authToken": authToken, "kind": "hosted-device"],
            bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
        return try JSONDecoder().decode(HostedPairingSession.self, from: data)
    }

    func hostedNodeEncryptionKey(nodeID: String, bearer: String) async throws -> String {
        struct Node: Decodable { let id: String; let encPubkey: String }
        struct Envelope: Decodable { let node: Node }
        let (data, response) = try await send(
            method: "GET", path: "/v1/nodes/\(try Self.pathComponent(nodeID))", body: nil, bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
        let node = try JSONDecoder().decode(Envelope.self, from: data).node
        guard node.id == nodeID else { throw RelayTrialFlowError.malformedResponse }
        return node.encPubkey
    }

    /// Only ciphertext crosses the account API. The pairing secret remains on
    /// this device and is opened by the account-owned node's X25519 key.
    func requestHostedDevicePairing(nodeID: String, pairingID: String, sealedSecret: Data, bearer: String) async throws {
        struct Accepted: Decodable { let ok: Bool; let pairingId: String; let expiresAt: Int64 }
        let (data, response) = try await send(
            method: "POST",
            path: "/v1/nodes/\(try Self.pathComponent(nodeID))/device-pairings",
            body: ["pairingId": pairingID, "sealedSecret": sealedSecret.base64EncodedString()],
            bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
        let accepted = try JSONDecoder().decode(Accepted.self, from: data)
        guard accepted.ok, accepted.pairingId == pairingID,
              accepted.expiresAt > Int64(Date().timeIntervalSince1970 * 1_000) else {
            throw RelayTrialFlowError.reconnectExpired
        }
    }

    func deleteTrial(bearer: String) async throws {
        let (data, response) = try await send(
            method: "DELETE",
            path: "/v1/trial-nodes/current",
            body: nil,
            bearer: bearer
        )
        try Self.throwIfError(response: response, data: data)
    }

    /// Joins the paid-tier waitlist. Public endpoint (no session bearer):
    /// `POST /v1/waitlist` with `{ "email": ... }`.
    func joinWaitlist(email: String) async throws {
        var request = URLRequest(url: endpoint("/v1/waitlist"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["email": email])

        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else {
            throw RelayTrialClientError.server(status: 0)
        }
        try Self.throwIfError(response: response, data: data)
    }

    func postDeviceBlob(pairingId: String, authToken: String, blob: Data, tag: String) async throws {
        let (data, response) = try await sendBlob(
            method: "POST",
            path: "/v1/pairing/sessions/\(pairingId)/device-blob",
            authToken: authToken,
            tag: tag,
            body: blob
        )
        try Self.throwIfError(response: response, data: data)
    }

    func fetchNodeBlob(pairingId: String, authToken: String) async throws -> (blob: Data, tag: String) {
        let (data, response) = try await sendBlob(
            method: "GET",
            path: "/v1/pairing/sessions/\(pairingId)/node-blob",
            authToken: authToken,
            tag: nil,
            body: nil
        )
        try Self.throwIfError(response: response, data: data)
        guard let tag = response.value(forHTTPHeaderField: "x-pairing-tag") else {
            throw RelayTrialClientError.tagMismatch
        }
        return (data, tag)
    }

    static func decodeTrialEnvelope(_ data: Data) throws -> RelayTrialNode {
        struct TrialEnvelope: Decodable { let trial: RelayTrialNode }
        return try JSONDecoder().decode(TrialEnvelope.self, from: data).trial
    }

    /// 409 is not one condition: only `trial_already_used` is the terminal
    /// "this account has had its trial" answer. Pairing's `slot_already_written`
    /// and enroll's `node_exists` are retryable conflicts and must not be
    /// reported to the user as a spent trial.
    static func mapError(status: Int, code: String?) -> RelayTrialClientError {
        switch (status, code) {
        case (404, "device_pairing_unavailable"), (404, "node_not_found"), (404, "not_found"): return .reconnectUnavailable
        case (403, "hosted_access_unavailable"): return .hostedAccessUnavailable
        case (409, "hosted_pairing_upgrade_required"): return .hostedUpgradeRequired
        case (409, "node_not_ready"): return .machineNotReady
        case (409, "trial_already_used"): return .alreadyUsed
        case (409, _): return .pairingConflict
        case (429, _): return .tooManyAttempts
        case (503, _): return .capacity
        case (502, _): return .provisionFailed
        case (404, "trial_unavailable"): return .unavailable
        case (404, "no_trial"): return .noTrial
        case (404, "not_posted_yet"): return .blobPending
        default: return .server(status: status)
        }
    }

    private static func throwIfError(response: HTTPURLResponse, data: Data) throws {
        guard !(200..<300).contains(response.statusCode) else { return }
        struct ErrorPayload: Decodable { let error: String? }
        let code = (try? JSONDecoder().decode(ErrorPayload.self, from: data))?.error
        throw mapError(status: response.statusCode, code: code)
    }

    private func send(
        method: String,
        path: String,
        body: [String: Any]?,
        bearer: String
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else {
            throw RelayTrialClientError.server(status: 0)
        }
        return (data, response)
    }

    private func sendBlob(
        method: String,
        path: String,
        authToken: String,
        tag: String?,
        body: Data?
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.setValue(authToken, forHTTPHeaderField: "X-Pairing-Auth")
        if let tag {
            request.setValue(tag, forHTTPHeaderField: "X-Pairing-Tag")
        }
        if let body {
            request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }

        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else {
            throw RelayTrialClientError.server(status: 0)
        }
        return (data, response)
    }

    private func endpoint(_ path: String) -> URL {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let requestPath = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + [basePath, requestPath].filter { !$0.isEmpty }.joined(separator: "/")
        components.query = nil
        components.fragment = nil
        return components.url!
    }

    private static func pathComponent(_ value: String) throws -> String {
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_.~"))
        guard !value.isEmpty, value.unicodeScalars.allSatisfy(safe.contains) else {
            throw RelayTrialFlowError.malformedResponse
        }
        return value
    }

    private var origin: String {
        var components = URLComponents()
        components.scheme = baseURL.scheme
        components.host = baseURL.host
        components.port = baseURL.port
        return components.string ?? baseURL.absoluteString
    }
}
