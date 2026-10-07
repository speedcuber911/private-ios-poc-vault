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
            return "This machine's power changed a moment ago. Try again in a few seconds."
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
    /// When the machine last came up from off. relayd needs some seconds
    /// after EC2 says running, and screens say "connecting" through that
    /// window instead of showing its first refused requests as errors.
    @Published private(set) var cameUpAt: Date?

    static let warmUpWindow: TimeInterval = 60

    /// EC2 tag reads are eventually consistent: a describe in the first
    /// seconds after a write can still carry the old value. Reads landing in
    /// this window after a save must not move the auto-stop switch back.
    static let autoStopTagLag: TimeInterval = 30
    private var autoStopSavedAt: Date?

    /// How long a start or stop is followed before it is called late.
    static let transitionTimeout: TimeInterval = 90
    /// An auto-wake powers on, waits for AWS, then waits for `/healthz`.
    static let wakeTimeout: TimeInterval = 150

    private var identityStore: ClientIdentityStore?
    private let powerClient: RelayMachinePowering
    /// Gap between reads while the machine is in motion or a read just failed.
    private let settleInterval: Duration
    /// Gap between reads once the machine has settled.
    private let steadyInterval: Duration
    /// Bumped by every start and stop. Anything that began under an older
    /// generation is stale and is thrown away, so a slow read can never move
    /// the switch back to the state it held before the user acted.
    private var generation = 0
    private var isReading = false
    private var isTransitioning = false
    /// The machine the published state describes. Pairing a different one
    /// starts over from `.loading` instead of showing the last machine's switch.
    private var nodeID: String?
    private var failedReads = 0
    private var lastReadAt: ContinuousClock.Instant?
    /// Set while a node request's auto-wake is starting the machine. EC2 goes
    /// on answering `stopped` for the first seconds of a start, and this model
    /// did not issue that start, so nothing else would stop a read in that
    /// window from showing Off for a machine that is coming up.
    private var wakeExpectedUntil: Date?

    private enum NoticeSource { case read, action }
    private var noticeSource: NoticeSource?

    private enum Target {
        case on, off

        /// The machine has arrived.
        func isReached(by state: RelayMachinePowerState) -> Bool {
            switch self {
            case .on: return state.isRunning
            case .off: return state.instanceState == "stopped"
            }
        }

        /// The machine is there or on its way, whoever sent it.
        func isUnderway(in state: RelayMachinePowerState) -> Bool {
            switch self {
            case .on: return state.isRunning || state.isStarting
            case .off: return state.isStopped
            }
        }
    }

    init(
        powerClient: RelayMachinePowering? = nil,
        settleInterval: Duration = .seconds(2),
        steadyInterval: Duration = .seconds(20)
    ) {
        self.powerClient = powerClient ?? RelayPowerClient(baseURL: AppConfiguration.authBaseURL)
        self.settleInterval = settleInterval
        self.steadyInterval = steadyInterval
    }

    var canControl: Bool { identityStore?.wakeCredential() != nil }

    /// EC2 says the machine is not serving: stopped, or on its way up or
    /// down. Only a real power reading says so, never a failed request, so
    /// a machine without power control is never called off.
    var isDown: Bool {
        status == .off || status == .starting || status == .stopping
    }

    /// Up, but so recently that relayd may still be starting.
    var isWarmingUp: Bool {
        guard status == .on, let cameUpAt else { return false }
        return Date().timeIntervalSince(cameUpAt) < Self.warmUpWindow
    }

    func configure(identityStore: ClientIdentityStore) {
        self.identityStore = identityStore
    }

    /// Keeps the switch honest for as long as a screen shows it: a read now,
    /// again every couple of seconds while the machine is in motion or a read
    /// failed, and slowly once it has settled. The machine also changes state
    /// behind the app's back (idle auto-stop, a node request's auto-wake,
    /// another phone), and one read on appear cannot see any of that.
    ///
    /// Runs inside a visibility- and scene-bound `.task`: leaving the screen
    /// or backgrounding the app stops it, and coming back starts with a read.
    func watch() async {
        await refresh()
        while !Task.isCancelled {
            // A short tick rather than one long sleep, so a machine that starts
            // moving mid-wait is followed at once. Settings and Usage can both
            // be watching; whichever ticks first reads, and that serves both.
            do { try await Task.sleep(for: settleInterval) } catch { return }
            if let lastReadAt, ContinuousClock.now - lastReadAt < nextReadDelay { continue }
            await refresh()
        }
    }

    private var nextReadDelay: Duration {
        // No credential yet costs nothing to check again: it arrives from the
        // node moments after the first request to it succeeds.
        if !canControl { return settleInterval }
        if failedReads > 0 {
            return min(settleInterval * (1 << min(failedReads - 1, 4)), steadyInterval)
        }
        return status.isBusy || status == .loading ? settleInterval : steadyInterval
    }

    /// A plain read. It yields to any start/stop that owns the switch, and to
    /// another read already in flight, rather than competing with it.
    func refresh() async {
        guard let credential = currentCredential() else { return }
        guard !isTransitioning, !isReading else { return }
        isReading = true
        let readGeneration = generation
        defer {
            isReading = false
            lastReadAt = .now
        }
        do {
            let state = try await powerClient.state(nodeID: credential.nodeID, wakeToken: credential.token)
            guard readGeneration == generation else { return }
            failedReads = 0
            apply(state)
            if resize?.stage != "failed", noticeSource != .action { setNotice(nil) }
        } catch let error as RelayMachinePowerError where error == .unconfigured || error == .unauthorized {
            guard readGeneration == generation else { return }
            failedReads = 0
            status = .unavailable
        } catch {
            // Backgrounding cancels the read under it. That is not a failure.
            guard readGeneration == generation, !Task.isCancelled else { return }
            failedReads += 1
            // A failed read is not evidence of a power state. Keep whatever we
            // last knew and say what went wrong instead of flipping the switch.
            if !status.isResolved {
                status = .unknown
            }
            // The first request after the app returns to the foreground often
            // dies on a socket iOS closed; it is retried within seconds, so
            // only a read that fails twice running is worth a line of red.
            if failedReads > 1, noticeSource != .action {
                setNotice(error.localizedDescription, source: .read)
            }
        }
    }

    /// A node request found the machine down and is starting it. Nothing on
    /// the power screens asked for that, so they are told here.
    func machineWakeBegan() {
        wakeExpectedUntil = Date().addingTimeInterval(Self.wakeTimeout)
        guard !isTransitioning else { return }
        // A read already in flight would answer with the state before the wake.
        generation += 1
        Task { await refresh() }
    }

    /// The auto-wake is over, started or not: EC2 is the authority again.
    func machineWakeEnded() {
        wakeExpectedUntil = nil
        Task { await refresh() }
    }

    func requestResize(to target: String) async {
        guard let credential = currentCredential(), let current = instanceType,
              resizeOptions.contains(target), target != current else { return }
        guard !isSubmittingResize && !isTransitioning && resize?.isActive != true else { return }
        generation += 1
        requestedResizeType = target
        isSubmittingResize = true
        defer {
            isSubmittingResize = false
            requestedResizeType = nil
        }
        setNotice(nil)
        do {
            apply(try await powerClient.resize(nodeID: credential.nodeID, wakeToken: credential.token,
                                               from: current, to: target))
        } catch {
            await refresh()
            setNotice(error.localizedDescription, source: .action)
        }
    }

    func setAutoStop(_ enabled: Bool) async {
        guard let credential = currentCredential(), !isSavingAutoStop,
              let previous = autoStopEnabled, previous != enabled else { return }
        autoStopEnabled = enabled
        isSavingAutoStop = true
        setNotice(nil)
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
            setNotice((error as? RelayMachinePowerError) == .rateLimited
                ? "Auto-stop changed a moment ago. Try again in a few seconds."
                : error.localizedDescription, source: .action)
        }
    }

    func waitForResize() async {
        while resize?.isActive == true && !Task.isCancelled {
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            await refresh()
        }
    }

    func start() async {
        await transition(to: .on)
    }

    func stop() async {
        await transition(to: .off)
    }

    /// Sends the start or stop, then follows the machine until it arrives.
    private func transition(to target: Target) async {
        guard !isSubmittingResize && resize?.isActive != true else { return }
        guard let credential = currentCredential() else { return }
        generation += 1
        let myGeneration = generation
        let previous = status
        status = target == .on ? .starting : .stopping
        setNotice(nil)
        isTransitioning = true
        defer { isTransitioning = false }

        var latest: RelayMachinePowerState
        do {
            latest = target == .on
                ? try await powerClient.start(nodeID: credential.nodeID, wakeToken: credential.token)
                : try await powerClient.stop(nodeID: credential.nodeID, wakeToken: credential.token)
            guard myGeneration == generation else { return }
        } catch {
            // The request failing is not evidence of a power state: a lost
            // reply may still have been carried out, and a rate limit means
            // something else (a node request's auto-wake, another phone) moved
            // the machine a moment ago. Ask where it is instead of guessing.
            let truth = try? await powerClient.state(nodeID: credential.nodeID, wakeToken: credential.token)
            guard myGeneration == generation else { return }
            guard let truth else {
                failedReads += 1
                status = previous.isBusy ? .unknown : previous
                setNotice(error.localizedDescription, source: .action)
                return
            }
            failedReads = 0
            // Already where the tap wanted it, or on its way: nothing to report.
            guard target.isUnderway(in: truth) || (target == .on && isAwaitingWake) else {
                apply(truth)
                setNotice(error.localizedDescription, source: .action)
                return
            }
            latest = truth
        }

        // EC2 keeps reporting `stopped` for the first seconds of a start, and
        // `stopping` is still in motion. Holding the busy state until the
        // machine arrives is what keeps the switch from snapping back.
        let deadline = Date().addingTimeInterval(Self.transitionTimeout)
        while !target.isReached(by: latest), Date() < deadline {
            do { try await Task.sleep(for: settleInterval) } catch { break }
            // One failed poll says nothing about the machine. Ask again.
            let next = try? await powerClient.state(nodeID: credential.nodeID, wakeToken: credential.token)
            guard myGeneration == generation else { return }
            if let next { latest = next }
        }
        apply(latest)
        if target == .on, !latest.isRunning {
            setNotice(RelayMachinePowerError.timeout.errorDescription, source: .action)
        }
    }

    private var isAwaitingWake: Bool {
        wakeExpectedUntil.map { Date() < $0 } ?? false
    }

    /// The wake credential. When it names a different machine than the
    /// published state describes (a re-pair, an unpair), that state is dropped.
    private func currentCredential() -> (nodeID: String, token: String)? {
        let credential = identityStore?.wakeCredential()
        if credential?.nodeID != nodeID {
            nodeID = credential?.nodeID
            generation += 1
            status = .loading
            instanceType = nil
            resizeOptions = []
            resize = nil
            pricing = nil
            autoStopEnabled = nil
            autoStopSavedAt = nil
            wakeExpectedUntil = nil
            failedReads = 0
            lastReadAt = nil
            setNotice(nil)
        }
        if credential == nil, status != .unavailable {
            status = .unavailable
        }
        return credential
    }

    private func setNotice(_ message: String?, source: NoticeSource = .read) {
        notice = message
        noticeSource = message == nil ? nil : source
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
        let next: Status
        if state.isRunning {
            wakeExpectedUntil = nil
            next = .on
        } else if state.isStarting {
            next = .starting
        } else if state.instanceState == "stopping" {
            next = .stopping
        } else if state.isStopped {
            next = isAwaitingWake ? .starting : .off
        } else {
            next = .unknown
        }
        // What a start or stop complained about stops being true once the
        // machine has moved on from it.
        if next != status, noticeSource == .action { setNotice(nil) }
        if next == .on, status == .off || status == .starting || status == .stopping {
            cameUpAt = Date()
        }
        status = next
        if state.resize?.stage == "failed" {
            setNotice("Size change failed. Check the machine's power and try again.")
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
