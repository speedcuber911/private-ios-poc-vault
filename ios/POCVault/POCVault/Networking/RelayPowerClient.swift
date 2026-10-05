import Foundation

struct RelayMachinePowerState: Equatable {
    struct Resize: Equatable {
        var targetType: String
        var stage: String
        var error: String?
        var wasRunning: Bool? = nil
        var isActive: Bool { !["complete", "failed"].contains(stage) }
    }

    struct Pricing: Equatable {
        var currency: String
        var hoursPerMonth: Int
        var checkedAt: String
        var hourlyUSD: [String: Double]

        func hourly(for instanceType: String) -> Double? { hourlyUSD[instanceType] }
        func monthly(for instanceType: String) -> Double? {
            hourly(for: instanceType).map { $0 * Double(hoursPerMonth) }
        }
    }

    var nodeID: String
    var instanceID: String?
    var region: String?
    var instanceState: String?
    var instanceType: String? = nil
    var resizeOptions: [String] = []
    var resize: Resize? = nil
    var pricing: Pricing? = nil
    /// Nil when the control plane predates idle auto-stop.
    var autoStopEnabled: Bool? = nil

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
    case resizeConflict
    case staleType
    case invalidSize

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
        case .resizeConflict:
            return "This machine is busy. Refresh its size and try again."
        case .staleType:
            return "The machine size changed. Refresh and choose again."
        case .invalidSize:
            return "That size is not available in this machine series."
        }
    }
}

protocol RelayMachinePowering: AnyObject {
    func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState
    func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState
    func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState
    func resize(nodeID: String, wakeToken: String, from: String, to: String) async throws -> RelayMachinePowerState
    func setAutoStop(nodeID: String, wakeToken: String, enabled: Bool) async throws -> RelayMachinePowerState
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

    func resize(nodeID: String, wakeToken: String, from: String, to: String) async throws -> RelayMachinePowerState {
        try await send(path: "/v1/power/\(Self.pathComponent(nodeID))/resize", method: "POST",
                       wakeToken: wakeToken, nodeID: nodeID,
                       body: ["expectedType": from, "targetType": to])
    }

    func setAutoStop(nodeID: String, wakeToken: String, enabled: Bool) async throws -> RelayMachinePowerState {
        try await send(path: "/v1/power/\(Self.pathComponent(nodeID))/autostop", method: "POST",
                       wakeToken: wakeToken, nodeID: nodeID,
                       body: ["enabled": enabled])
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

    private func send(path: String, method: String, wakeToken: String, nodeID: String,
                      body: (any Encodable)? = nil) async throws -> RelayMachinePowerState {
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
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
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
        case 200, 201, 202:
            break
        case 401:
            throw RelayMachinePowerError.unauthorized
        case 429:
            throw RelayMachinePowerError.rateLimited
        case 502:
            throw RelayMachinePowerError.awsFailed
        case 503:
            throw RelayMachinePowerError.unconfigured
        case 400:
            throw RelayMachinePowerError.invalidSize
        case 409:
            let code = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw code == "instance_type_changed" ? RelayMachinePowerError.staleType : .resizeConflict
        default:
            throw RelayMachinePowerError.httpFailure(http.statusCode)
        }
        struct Envelope: Decodable {
            struct Power: Decodable {
                var nodeId: String?
                var instanceId: String?
                var region: String?
                var instanceState: String?
                var instanceType: String?
                var resizeOptions: [String]?
                struct Pricing: Decodable {
                    var currency: String
                    var hoursPerMonth: Int
                    var checkedAt: String
                    var hourlyUSD: [String: Double]
                }
                var pricing: Pricing?
                struct Resize: Decodable {
                    var targetType: String
                    var stage: String
                    var error: String?
                    var wasRunning: Bool?
                }
                var resize: Resize?
                var autoStopEnabled: Bool?
            }
            var power: Power?
        }
        let envelope = try decoder.decode(Envelope.self, from: data)
        return RelayMachinePowerState(
            nodeID: envelope.power?.nodeId ?? nodeID,
            instanceID: envelope.power?.instanceId,
            region: envelope.power?.region,
            instanceState: envelope.power?.instanceState,
            instanceType: envelope.power?.instanceType,
            resizeOptions: envelope.power?.resizeOptions ?? [],
            resize: envelope.power?.resize.map {
                RelayMachinePowerState.Resize(targetType: $0.targetType, stage: $0.stage,
                                              error: $0.error, wasRunning: $0.wasRunning)
            },
            pricing: envelope.power?.pricing.map {
                RelayMachinePowerState.Pricing(currency: $0.currency, hoursPerMonth: $0.hoursPerMonth,
                                               checkedAt: $0.checkedAt, hourlyUSD: $0.hourlyUSD)
            },
            autoStopEnabled: envelope.power?.autoStopEnabled
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
    @Published private(set) var instanceType: String?
    @Published private(set) var resizeOptions: [String] = []
    @Published private(set) var resize: RelayMachinePowerState.Resize?
    @Published private(set) var pricing: RelayMachinePowerState.Pricing?
    @Published private(set) var isSubmittingResize = false
    @Published private(set) var requestedResizeType: String?
    @Published private(set) var autoStopEnabled: Bool?
    @Published private(set) var isSavingAutoStop = false

    /// EC2 tag reads are eventually consistent: a describe in the first
    /// seconds after a write can still carry the old value. Reads landing in
    /// this window after a save must not move the auto-stop switch back.
    static let autoStopTagLag: TimeInterval = 30
    private var autoStopSavedAt: Date?

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
            if resize?.stage != "failed" { notice = nil }
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

    func requestResize(to target: String) async {
        guard let credential = identityStore?.wakeCredential(), let current = instanceType,
              resizeOptions.contains(target), target != current else { return }
        guard !isSubmittingResize && !isTransitioning && resize?.isActive != true else { return }
        generation += 1
        requestedResizeType = target
        isSubmittingResize = true
        defer {
            isSubmittingResize = false
            requestedResizeType = nil
        }
        notice = nil
        do {
            apply(try await powerClient.resize(nodeID: credential.nodeID, wakeToken: credential.token,
                                               from: current, to: target))
        } catch {
            await refresh()
            notice = error.localizedDescription
        }
    }

    func setAutoStop(_ enabled: Bool) async {
        guard let credential = identityStore?.wakeCredential(), !isSavingAutoStop,
              let previous = autoStopEnabled, previous != enabled else { return }
        autoStopEnabled = enabled
        isSavingAutoStop = true
        notice = nil
        do {
            let state = try await powerClient.setAutoStop(nodeID: credential.nodeID, wakeToken: credential.token,
                                                          enabled: enabled)
            autoStopEnabled = state.autoStopEnabled ?? enabled
            autoStopSavedAt = Date()
            isSavingAutoStop = false
        } catch {
            autoStopEnabled = previous
            autoStopSavedAt = nil
            isSavingAutoStop = false
            // A lost reply does not mean a lost write; read the tag back.
            await refresh()
            notice = (error as? RelayMachinePowerError) == .rateLimited
                ? "Auto-stop changed a moment ago. Try again in a few seconds."
                : error.localizedDescription
        }
    }

    func waitForResize() async {
        while resize?.isActive == true && !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            await refresh()
        }
    }

    func start() async {
        guard !isSubmittingResize && resize?.isActive != true else { return }
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
        guard !isSubmittingResize && resize?.isActive != true else { return }
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
        instanceType = state.instanceType ?? instanceType
        resizeOptions = state.resizeOptions.isEmpty ? resizeOptions : state.resizeOptions
        resize = state.resize
        // A full describe carries the current type. Clear an old quote when
        // this type or region has no supported price; start/stop replies omit
        // the type and should retain the last quote until the next read.
        if state.instanceType != nil { pricing = state.pricing }
        if let value = state.autoStopEnabled, !isSavingAutoStop,
           Date().timeIntervalSince(autoStopSavedAt ?? .distantPast) >= Self.autoStopTagLag {
            autoStopEnabled = value
        }
        if state.resize?.stage == "failed" {
            notice = "Size change failed. Check the machine's power and try again."
        }
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

/// Signs a phone up for one machine's power pushes (paused, ready), with the
/// pairing wake token as the only credential.
protocol RelayPowerPushSubscribing: AnyObject {
    func subscribePush(nodeID: String, wakeToken: String, apnsToken: String, environment: String) async throws
    func unsubscribePush(nodeID: String, wakeToken: String, apnsToken: String) async throws
}

extension RelayPowerClient: RelayPowerPushSubscribing {
    func subscribePush(nodeID: String, wakeToken: String, apnsToken: String, environment: String) async throws {
        _ = try await send(path: "/v1/power/\(Self.pathComponent(nodeID))/push", method: "PUT",
                           wakeToken: wakeToken, nodeID: nodeID,
                           body: ["apnsToken": apnsToken, "apnsEnvironment": environment])
    }

    func unsubscribePush(nodeID: String, wakeToken: String, apnsToken: String) async throws {
        _ = try await send(path: "/v1/power/\(Self.pathComponent(nodeID))/push", method: "DELETE",
                           wakeToken: wakeToken, nodeID: nodeID,
                           body: ["apnsToken": apnsToken])
    }
}
