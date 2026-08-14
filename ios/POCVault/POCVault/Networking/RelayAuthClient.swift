import Foundation

enum RelayAuthClientError: Error, LocalizedError, Equatable {
    case invalidResponse
    case missingSessionToken
    case server(status: Int, code: String?, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Relay could not read the authentication response."
        case .missingSessionToken:
            return "Relay signed in, but no secure session was returned."
        case .server(_, let code, let message):
            switch code {
            case "INVALID_USERNAME_OR_PASSWORD", "INVALID_EMAIL_OR_PASSWORD":
                return "The username or password is incorrect."
            case "USERNAME_IS_ALREADY_TAKEN":
                return "That username is already taken."
            case "USER_ALREADY_EXISTS":
                return "An account already exists for that email."
            case "PASSWORD_TOO_SHORT":
                return "Use a password with at least 8 characters."
            case "SESSION_EXPIRED":
                return "Please sign in again before deleting your account."
            case "INVALID_PASSWORD":
                return "The password is incorrect."
            case "PROVIDER_NOT_FOUND":
                return "Sign in with Apple is not configured on the Relay server yet."
            case "computer_already_linked":
                return "A computer is already connected. Disconnect it before linking another one."
            case "OAUTH_LINK_ERROR", "SOCIAL_ACCOUNT_ALREADY_LINKED", "LINKED_ACCOUNT_ALREADY_EXISTS":
                return "This Apple ID is already used on a different Relay account. Sign in with your username and password, or use the Apple ID that created that account."
            default:
                return message
            }
        }
    }

    static func decode(status: Int, data: Data) -> RelayAuthClientError {
        let payload = (try? JSONDecoder().decode(ErrorPayload.self, from: data))
        let fallback = HTTPURLResponse.localizedString(forStatusCode: status).capitalized
        return .server(
            status: status,
            code: payload?.code ?? payload?.error,
            message: payload?.message ?? payload?.error ?? fallback
        )
    }

    private struct ErrorPayload: Decodable {
        let code: String?
        let message: String?
        let error: String?
    }
}

final class RelayAuthClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func signUp(
        username: String,
        email: String,
        password: String
    ) async throws -> (RelayAccountUser, String) {
        guard let response: RelayAuthResult = try await request(
            method: "POST",
            path: "/api/auth/sign-up/email",
            body: [
                "name": username,
                "username": username,
                "email": email,
                "password": password
            ]
        ) else { throw RelayAuthClientError.invalidResponse }
        return (response.user, try sessionToken(response.token))
    }

    func signIn(username: String, password: String) async throws -> (RelayAccountUser, String) {
        guard let response: RelayAuthResult = try await request(
            method: "POST",
            path: "/api/auth/sign-in/username",
            body: ["username": username, "password": password]
        ) else { throw RelayAuthClientError.invalidResponse }
        return (response.user, try sessionToken(response.token))
    }

    func signInWithApple(
        identityToken: String,
        nonce: String,
        email: String?,
        firstName: String?,
        lastName: String?
    ) async throws -> (RelayAccountUser, String) {
        var appleUser: [String: Any] = [:]
        let name = [
            "firstName": firstName,
            "lastName": lastName
        ].compactMapValues { $0 }
        if !name.isEmpty { appleUser["name"] = name }
        if let email, !email.isEmpty { appleUser["email"] = email }

        var idToken: [String: Any] = [
            "token": identityToken,
            "nonce": nonce
        ]
        if !appleUser.isEmpty { idToken["user"] = appleUser }

        guard let response: RelayAuthResult = try await request(
            method: "POST",
            path: "/api/auth/sign-in/social",
            body: [
                "provider": "apple",
                "requestSignUp": true,
                "idToken": idToken
            ]
        ) else { throw RelayAuthClientError.invalidResponse }
        return (response.user, try sessionToken(response.token))
    }

    func session(for bearerToken: String) async throws -> RelayAccountUser? {
        let response: RelaySessionResult? = try await request(
            method: "GET",
            path: "/api/auth/get-session",
            bearerToken: bearerToken,
            allowsEmptyResponse: true
        )
        return response?.user
    }

    func signOut(bearerToken: String) async throws {
        let _: EmptyResponse? = try await request(
            method: "POST",
            path: "/api/auth/sign-out",
            body: [:],
            bearerToken: bearerToken,
            allowsEmptyResponse: true
        )
    }

    func deleteAccount(password: String?, bearerToken: String) async throws {
        var body: [String: Any] = [:]
        if let password, !password.isEmpty { body["password"] = password }
        guard let response: RelayDeleteAccountResult = try await request(
            method: "POST",
            path: "/api/auth/delete-user",
            body: body,
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        guard response.success else { throw RelayAuthClientError.invalidResponse }
    }

    func deviceInspect(userCode: String, bearerToken: String) async throws -> DeviceCodeInspectResult {
        struct Payload: Decodable {
            let machineName: String?
            let platform: String?
            let createdAt: Int64
            let expiresAt: Int64
            let client: String?
        }
        guard let response: Payload = try await request(
            method: "POST",
            path: "/v1/auth/device/inspect",
            body: ["userCode": userCode],
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        return DeviceCodeInspectResult(
            machineName: response.machineName,
            platform: response.platform,
            createdAt: response.createdAt,
            expiresAt: response.expiresAt,
            client: response.client == "web" ? .web : .cli
        )
    }

    func deviceApprove(userCode: String, bearerToken: String) async throws {
        struct Payload: Decodable { let ok: Bool? }
        guard let response: Payload = try await request(
            method: "POST",
            path: "/v1/auth/device/approve",
            body: ["userCode": userCode],
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        guard response.ok == true else { throw RelayAuthClientError.invalidResponse }
    }

    func computerLinkState(bearerToken: String) async throws -> CLIComputerLinkState {
        guard let response: CLIComputerLinkState = try await request(
            method: "GET",
            path: "/v1/auth/device/link",
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        return response
    }

    func disconnectComputer(bearerToken: String) async throws {
        struct Payload: Decodable { let ok: Bool }
        guard let response: Payload = try await request(
            method: "DELETE",
            path: "/v1/auth/device/link",
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        guard response.ok else { throw RelayAuthClientError.invalidResponse }
    }

    func signedInPlaces(bearerToken: String) async throws -> RelaySignedInPlaces {
        guard let response: RelaySignedInPlaces = try await request(
            method: "GET",
            path: "/v1/auth/places",
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        return response
    }

    func removeBrowser(id: String, bearerToken: String) async throws {
        struct Payload: Decodable { let ok: Bool }
        guard let response: Payload = try await request(
            method: "DELETE",
            path: "/v1/auth/places/browsers/\(id)",
            bearerToken: bearerToken
        ) else { throw RelayAuthClientError.invalidResponse }
        guard response.ok else { throw RelayAuthClientError.invalidResponse }
    }

    private func sessionToken(_ bodyToken: String?) throws -> String {
        guard let token = lastResponseToken ?? bodyToken, !token.isEmpty else {
            throw RelayAuthClientError.missingSessionToken
        }
        lastResponseToken = nil
        return token
    }

    // Requests are serialized by the account store, so this short-lived value
    // can carry Better Auth's native bearer header into the typed result.
    private var lastResponseToken: String?

    private func request<Response: Decodable>(
        method: String,
        path: String,
        body: [String: Any]? = nil,
        bearerToken: String? = nil,
        allowsEmptyResponse: Bool = false
    ) async throws -> Response? {
        var request = URLRequest(url: endpoint(path))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(origin, forHTTPHeaderField: "Origin")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        if let bearerToken {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else {
            throw RelayAuthClientError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw RelayAuthClientError.decode(status: response.statusCode, data: data)
        }

        lastResponseToken = response.value(forHTTPHeaderField: "set-auth-token")
        if data.isEmpty || String(data: data, encoding: .utf8) == "null" {
            if allowsEmptyResponse { return nil }
            throw RelayAuthClientError.invalidResponse
        }
        return try JSONDecoder().decode(Response.self, from: data)
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

    private var origin: String {
        var components = URLComponents()
        components.scheme = baseURL.scheme
        components.host = baseURL.host
        components.port = baseURL.port
        return components.string ?? baseURL.absoluteString
    }

    private struct EmptyResponse: Decodable {}
}
