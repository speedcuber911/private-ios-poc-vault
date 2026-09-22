import Foundation

struct RelayMachinePowerState: Equatable {
    var nodeID: String
    var instanceID: String?
    var region: String?
    var instanceState: String?

    var isRunning: Bool { instanceState == "running" }
    var isStopped: Bool {
        switch instanceState {
        case "stopped", "stopping": return true
        default: return false
        }
    }
    var isStarting: Bool { instanceState == "pending" }
}

enum RelayMachinePowerError: Error, Equatable, LocalizedError {
    case invalidEndpoint
    case unauthorized
    case unconfigured
    case rateLimited
    case awsFailed
    case httpFailure(Int)
    case timeout

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "Relay could not reach the machine power service."
        case .unauthorized:
            return "This phone is not allowed to start that machine."
        case .unconfigured:
            return "Machine start/stop is not configured on the control plane."
        case .rateLimited:
            return "That machine was started too recently. Try again in a moment."
        case .awsFailed:
            return "Relay could not change the machine's power state."
        case .httpFailure(let status):
            return "Machine power request failed (\(status))."
        case .timeout:
            return "The machine did not come up in time."
        }
    }
}

protocol RelayMachinePowering: AnyObject {
    func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState
    func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState
    func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState
}

/// Talks to the control plane's power routes. No Relay account: the wake
/// token from pairing (or GET /v1/power/credential) is the credential.
final class RelayPowerClient: RelayMachinePowering {
    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
        decoder.keyDecodingStrategy = .convertFromSnakeCase
    }

    func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        try await send(path: "/v1/power/\(Self.pathComponent(nodeID))/start", method: "POST", wakeToken: wakeToken, nodeID: nodeID)
    }

    func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        try await send(path: "/v1/power/\(Self.pathComponent(nodeID))/stop", method: "POST", wakeToken: wakeToken, nodeID: nodeID)
    }

    func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        try await send(path: "/v1/power/\(Self.pathComponent(nodeID))", method: "GET", wakeToken: wakeToken, nodeID: nodeID)
    }

    static func isMachineUnreachable(_ error: Error) -> Bool {
        let nsError = error as NSError
        guard nsError.domain == NSURLErrorDomain else { return false }
        switch nsError.code {
        case NSURLErrorCannotConnectToHost,
             NSURLErrorTimedOut,
             NSURLErrorNetworkConnectionLost,
             NSURLErrorDNSLookupFailed,
             NSURLErrorCannotFindHost:
            return true
        default:
            return false
        }
    }

    private func send(path: String, method: String, wakeToken: String, nodeID: String) async throws -> RelayMachinePowerState {
        let root = baseURL.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let normalized = path.hasPrefix("/") ? path : "/\(path)"
        guard let url = URL(string: "\(root)\(normalized)") else {
            throw RelayMachinePowerError.invalidEndpoint
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(wakeToken)", forHTTPHeaderField: "Authorization")
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw RelayMachinePowerError.invalidEndpoint
        }
        guard let http = response as? HTTPURLResponse else {
            throw RelayMachinePowerError.invalidEndpoint
        }
        switch http.statusCode {
        case 200, 201:
            break
        case 401:
            throw RelayMachinePowerError.unauthorized
        case 429:
            throw RelayMachinePowerError.rateLimited
        case 502:
            throw RelayMachinePowerError.awsFailed
        case 503:
            throw RelayMachinePowerError.unconfigured
        default:
            throw RelayMachinePowerError.httpFailure(http.statusCode)
        }
        struct Envelope: Decodable {
            struct Power: Decodable {
                var nodeId: String?
                var instanceId: String?
                var region: String?
                var instanceState: String?
            }
            var power: Power?
        }
        let envelope = try decoder.decode(Envelope.self, from: data)
        return RelayMachinePowerState(
            nodeID: envelope.power?.nodeId ?? nodeID,
            instanceID: envelope.power?.instanceId,
            region: envelope.power?.region,
            instanceState: envelope.power?.instanceState
        )
    }

    private static func pathComponent(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? value
    }
}

@MainActor
final class RelayMachinePowerModel: ObservableObject {
    enum Status: Equatable {
        /// No power state has been read yet. Distinct from `off` so the switch
        /// never renders a guessed position it then has to correct.
        case loading
        case unknown
        case unavailable
        case on
        case off
        case starting
        case stopping

        var label: String {
            switch self {
            case .loading: return "Checking"
            case .unknown: return "Unknown"
            case .unavailable: return "Unavailable"
            case .on: return "On"
            case .off: return "Off"
            case .starting: return "Starting"
            case .stopping: return "Stopping"
            }
        }

        var isBusy: Bool {
            self == .starting || self == .stopping
        }

        var isPowered: Bool {
            self == .on || self == .starting
        }

        /// True once a real answer stands behind the position of the switch.
        var isResolved: Bool {
            self != .loading
        }

        var canToggle: Bool {
            switch self {
            case .loading, .unavailable, .starting, .stopping: return false
            case .unknown, .on, .off: return true
            }
        }

        var switchDetail: String? {
            switch self {
            case .loading: return "Checking…"
            case .starting: return "Starting…"
            case .stopping: return "Stopping…"
            case .unavailable: return "Unavailable"
            case .unknown: return "Unknown"
            case .on, .off: return nil
            }
        }
    }

    @Published private(set) var status: Status = .loading
    @Published private(set) var notice: String?

    private var identityStore: ClientIdentityStore?
    private let powerClient: RelayMachinePowering
    /// Bumped by every start and stop. Anything that began under an older
    /// generation is stale and is thrown away, so a slow read can never move
    /// the switch back to the state it held before the user acted.
    private var generation = 0
    private var isReading = false
    private var isTransitioning = false

    init(powerClient: RelayMachinePowering? = nil) {
        self.powerClient = powerClient ?? RelayPowerClient(baseURL: AppConfiguration.authBaseURL)
    }

    var canControl: Bool { identityStore?.wakeCredential() != nil }

    func configure(identityStore: ClientIdentityStore) {
        self.identityStore = identityStore
    }

    /// A plain read. It yields to any start/stop that owns the switch, and to
    /// another read already in flight, rather than competing with it.
    func refresh() async {
        guard let credential = identityStore?.wakeCredential() else {
            status = .unavailable
            return
        }
        guard !isTransitioning, !isReading else { return }
        isReading = true
        let readGeneration = generation
        defer { isReading = false }
        do {
            let state = try await powerClient.state(nodeID: credential.nodeID, wakeToken: credential.token)
            guard readGeneration == generation else { return }
            apply(state)
            notice = nil
        } catch let error as RelayMachinePowerError where error == .unconfigured || error == .unauthorized {
            guard readGeneration == generation else { return }
            status = .unavailable
        } catch {
            guard readGeneration == generation else { return }
            // A failed read is not evidence of a power state. Keep whatever we
            // last knew and say what went wrong instead of flipping the switch.
            if !status.isResolved {
                status = .unknown
            }
            notice = error.localizedDescription
        }
    }

    func start() async {
        guard let credential = identityStore?.wakeCredential() else {
            status = .unavailable
            return
        }
        generation += 1
        let myGeneration = generation
        status = .starting
        notice = nil
        isTransitioning = true
        defer { isTransitioning = false }
        do {
            var state = try await powerClient.start(nodeID: credential.nodeID, wakeToken: credential.token)
            let deadline = Date().addingTimeInterval(90)
            while Date() < deadline {
                guard myGeneration == generation else { return }
                // EC2 keeps reporting `stopped` for the first seconds of a
                // start. Staying on `.starting` until it actually runs is what
                // keeps the switch from snapping back to off and then on.
                if state.isRunning {
                    apply(state)
                    return
                }
                try await Task.sleep(for: .seconds(2))
                state = try await powerClient.state(nodeID: credential.nodeID, wakeToken: credential.token)
            }
            guard myGeneration == generation else { return }
            apply(state)
            if !state.isRunning {
                notice = RelayMachinePowerError.timeout.errorDescription
            }
        } catch {
            guard myGeneration == generation else { return }
            status = .off
            notice = error.localizedDescription
        }
    }

    func stop() async {
        guard let credential = identityStore?.wakeCredential() else {
            status = .unavailable
            return
        }
        generation += 1
        let myGeneration = generation
        status = .stopping
        notice = nil
        isTransitioning = true
        defer { isTransitioning = false }
        do {
            var state = try await powerClient.stop(nodeID: credential.nodeID, wakeToken: credential.token)
            let deadline = Date().addingTimeInterval(90)
            while Date() < deadline {
                guard myGeneration == generation else { return }
                // `stopping` is still in motion; only a settled `stopped`
                // ends the transition and turns the switch off.
                if state.instanceState == "stopped" {
                    apply(state)
                    return
                }
                try await Task.sleep(for: .seconds(2))
                state = try await powerClient.state(nodeID: credential.nodeID, wakeToken: credential.token)
            }
            guard myGeneration == generation else { return }
            apply(state)
        } catch {
            guard myGeneration == generation else { return }
            status = .on
            notice = error.localizedDescription
        }
    }

    private func apply(_ state: RelayMachinePowerState) {
        if state.isRunning {
            status = .on
        } else if state.isStarting {
            status = .starting
        } else if state.instanceState == "stopping" {
            status = .stopping
        } else if state.isStopped {
            status = .off
        } else {
            status = .unknown
        }
    }
}
