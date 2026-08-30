import Foundation

/// Errors that originate in the flow itself (not the network client or the
/// identity store), each with a message ready to surface to the user.
enum RelayTrialFlowError: Error, Equatable {
    case tagMismatch
    case machineUnavailable(RelayTrialNode.State)
    case machineTimedOut
    case pairingTimedOut
    case malformedResponse
    case reconnectExpired
}

/// Drives the "Try instantly" fork end to end: mints a pairing secret, asks the
/// cloud to provision a trial machine, hands the node a device blob, waits for
/// the machine to boot and hand back a paired PKCS#12 identity, then imports it
/// and adopts the trial node as the app's active endpoint.
///
/// Every failure path — network, server-reported, or local (tag mismatch, keychain
/// import) — is caught in `start()` and turned into `.failed(message)`. Both poll
/// loops (machine boot, blob pairing) are bounded, so the flow can never hang
/// forever even against a server that never reaches a terminal state.
@MainActor
final class RelayTrialFlowModel: ObservableObject {
    enum Step: Equatable {
        case idle
        case discovering
        case reconnecting
        case creating
        case waitingForMachine
        case pairing
        case importingIdentity
        case done
        case failed(String)
    }

    @Published private(set) var step: Step = .idle

    enum RestoreOutcome: Equatable {
        case noMachine
        case restored
        case setupRequired(RelayTrialNode.State)
    }

    private let client: RelayTrialClient
    private let identityStore: ClientIdentityStore
    private let nodeStore: RelayNodeStore
    private let pollIntervalNs: UInt64

    // Bounds on the two poll loops so a server that never reaches a terminal
    // state cannot hang the flow forever. At the default 2s interval this is
    // ~5 minutes for the machine to boot and ~3 minutes to complete pairing —
    // generous relative to the node-side pairing timeout (120s, trialpair.mjs).
    private static let maxReadyPollAttempts = 150
    private static let maxBlobPollAttempts = 90

    init(
        client: RelayTrialClient,
        identityStore: ClientIdentityStore,
        nodeStore: RelayNodeStore,
        pollIntervalNs: UInt64 = 2_000_000_000
    ) {
        self.client = client
        self.identityStore = identityStore
        self.nodeStore = nodeStore
        self.pollIntervalNs = pollIntervalNs
    }

    func start(bearer: String, deviceName: String) async {
        step = .idle
        do {
            let secret = RelayTrialPairing.generateSecret()
            let authToken = RelayTrialPairing.authToken(secret: secret)
            let macKey = RelayTrialPairing.macKey(secret: secret)

            let pairingId = try await client.createPairingSession(authToken: authToken, bearer: bearer)

            step = .creating
            let created: RelayTrialNode
            do {
                created = try await client.createTrial(pairingId: pairingId, pairingSecret: secret, bearer: bearer)
            } catch RelayTrialClientError.alreadyUsed {
                // A returning user, not a rule-breaker. This flow used to run
                // straight into `createTrial` on every entry and dead-end here
                // with "This account's trial was already used" — true, useless,
                // and wrong whenever the machine is still running and this
                // device can still reach it. Ask what the account actually has
                // before deciding there is nothing to do.
                let outcome = try await restoreExisting(bearer: bearer, deviceName: deviceName)
                if case .setupRequired(let state) = outcome {
                    throw RelayTrialFlowError.machineUnavailable(state)
                }
                if outcome == .noMachine { throw RelayTrialClientError.noTrial }
                return
            }

            let deviceBlob = try Self.encodeDeviceBlob(deviceName: deviceName)
            let deviceTag = RelayTrialPairing.blobTag(macKey: macKey, slot: RelayTrialPairing.deviceSlot, blob: deviceBlob)
            try await client.postDeviceBlob(pairingId: pairingId, authToken: authToken, blob: deviceBlob, tag: deviceTag)

            step = .waitingForMachine
            let readyTrial = try await waitForReady(trial: created, bearer: bearer)
            guard Self.hostedNodeURL(for: readyTrial) != nil else {
                throw RelayTrialFlowError.malformedResponse
            }

            step = .pairing
            let (nodeBlob, nodeTag) = try await waitForNodeBlob(pairingId: pairingId, authToken: authToken)
            guard RelayTrialPairing.verifyTag(macKey: macKey, slot: RelayTrialPairing.nodeSlot, blob: nodeBlob, tag: nodeTag) else {
                throw RelayTrialFlowError.tagMismatch
            }

            let p12URL = try Self.writeTemporaryP12(nodeBlob)
            defer { try? FileManager.default.removeItem(at: p12URL) }

            step = .importingIdentity
            // The machine's SNI host is handed over with the import so the node
            // CA inside the blob is pinned to that host and nothing else — the
            // phone cannot otherwise validate a passthrough-routed machine.
            _ = try identityStore.importIdentity(
                from: p12URL,
                passphrase: RelayTrialPairing.p12Passphrase(secret: secret),
                trialHost: readyTrial.sni
            )

            // The bearer token this device authenticates to the machine with,
            // derived from the same pairing secret the machine derives it from.
            // Stored before the machine is adopted so the first request after
            // adoption already carries it.
            identityStore.storeDeviceToken(
                RelayTrialPairing.deviceToken(secret: secret),
                host: readyTrial.sni
            )

            // Fetch once more after credential collection. Operator-entitled
            // hosted accounts are promoted when the node blob is redeemed, so
            // the phone should adopt the permanent state immediately and never
            // flash a trial countdown. Ordinary trials simply return `ready`.
            let finalTrial = (try? await client.currentTrial(bearer: bearer)) ?? readyTrial
            nodeStore.adoptTrial(finalTrial)
            step = .done
        } catch {
            step = .failed(Self.message(for: error))
        }
    }

    /// Account-authenticated discovery works before this device has a persisted
    /// node pointer. Ready trials and upgraded hosted machines use the same
    /// per-device recovery path; it never provisions or replaces a machine.
    func restoreExisting(
        bearer: String,
        deviceName: String,
        isAuthorized: @escaping @MainActor () -> Bool = { true }
    ) async throws -> RestoreOutcome {
        func requireAuthorization() throws {
            try Task.checkCancellation()
            guard isAuthorized() else { throw CancellationError() }
        }
        try requireAuthorization()
        step = .discovering
        let current: RelayTrialNode
        do {
            current = try await client.currentTrial(bearer: bearer)
        } catch RelayTrialClientError.noTrial {
            try requireAuthorization()
            nodeStore.applyRefresh(.failure(RelayTrialClientError.noTrial))
            step = .idle
            return .noMachine
        }
        try requireAuthorization()
        guard Self.isReconnectable(current.state) else {
            nodeStore.updateTrial(current)
            step = .idle
            return .setupRequired(current.state)
        }
        guard let host = current.sni, let nodeID = current.nodeId,
              let nodeURL = Self.hostedNodeURL(for: current) else {
            throw RelayTrialFlowError.malformedResponse
        }

        if Self.canReuseHostedCredential(
            host: host,
            pinnedHost: identityStore.pinnedHost,
            hasPinnedCA: identityStore.pinnedCACertificate != nil,
            hasIdentity: identityStore.hasStoredIdentity,
            isTrialIdentity: identityStore.hasTrialIssuedIdentity,
            hasHostToken: identityStore.deviceToken(for: host) != nil
        ) {
            do {
                // A read-only authenticated request confirms that retained
                // credentials still work. An outage does not revoke or replace
                // them; only an explicit authentication rejection re-pairs.
                _ = try await CodexClient(baseURL: nodeURL, identityStore: identityStore).fetchCodexWorkspaces()
                try requireAuthorization()
                nodeStore.adoptTrial(current)
                step = .done
                return .restored
            } catch let error as CodexClientError where error.statusCode == 401 || error.statusCode == 403 {
                try requireAuthorization()
            }
        }

        step = .reconnecting
        let nodeKey = try await client.hostedNodeEncryptionKey(nodeID: nodeID, bearer: bearer)
        try requireAuthorization()
        let secret = RelayTrialPairing.generateSecret()
        let authToken = RelayTrialPairing.authToken(secret: secret)
        let macKey = RelayTrialPairing.macKey(secret: secret)
        let session = try await client.createHostedPairingSession(authToken: authToken, bearer: bearer)
        try requireAuthorization()
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        guard session.expiresAt > now, session.expiresAt <= now + 960_000 else {
            throw RelayTrialFlowError.reconnectExpired
        }
        let deviceBlob = try Self.encodeDeviceBlob(deviceName: deviceName)
        try await client.postDeviceBlob(
            pairingId: session.pairingId,
            authToken: authToken,
            blob: deviceBlob,
            tag: RelayTrialPairing.blobTag(macKey: macKey, slot: RelayTrialPairing.deviceSlot, blob: deviceBlob)
        )
        try requireAuthorization()
        let sealed = try RelayTrialPairing.sealHostedPairingSecret(
            nodeID: nodeID, pairingID: session.pairingId, secret: secret,
            expiresAt: session.expiresAt, recipientPublicKey: nodeKey
        )
        try await client.requestHostedDevicePairing(nodeID: nodeID, pairingID: session.pairingId, sealedSecret: sealed, bearer: bearer)
        try requireAuthorization()
        step = .pairing
        let (nodeBlob, nodeTag) = try await waitForNodeBlob(pairingId: session.pairingId, authToken: authToken, isAuthorized: isAuthorized)
        try requireAuthorization()
        guard RelayTrialPairing.verifyTag(macKey: macKey, slot: RelayTrialPairing.nodeSlot, blob: nodeBlob, tag: nodeTag) else {
            throw RelayTrialFlowError.tagMismatch
        }
        let latest = try await client.currentTrial(bearer: bearer)
        try requireAuthorization()
        guard Self.isReconnectable(latest.state), latest.nodeId == nodeID,
              latest.sni?.lowercased() == host.lowercased() else {
            throw RelayTrialFlowError.machineUnavailable(latest.state)
        }
        let p12URL = try Self.writeTemporaryP12(nodeBlob)
        defer { try? FileManager.default.removeItem(at: p12URL) }
        step = .importingIdentity
        _ = try identityStore.importIdentity(from: p12URL, passphrase: RelayTrialPairing.p12Passphrase(secret: secret), trialHost: host)
        identityStore.storeDeviceToken(RelayTrialPairing.deviceToken(secret: secret), host: host)
        nodeStore.adoptTrial(latest)
        step = .done
        return .restored
    }

    static func isReconnectable(_ state: RelayTrialNode.State) -> Bool {
        state == .ready || state == .upgraded
    }

    private static func hostedNodeURL(for trial: RelayTrialNode) -> URL? {
        guard let host = trial.sni, let nodeID = trial.nodeId, !nodeID.isEmpty,
              let nodeURL = trial.nodeURL, nodeURL.scheme == "https",
              nodeURL.host?.lowercased() == host.lowercased(), nodeURL.user == nil,
              nodeURL.password == nil, nodeURL.port == nil, nodeURL.path.isEmpty,
              nodeURL.query == nil, nodeURL.fragment == nil else { return nil }
        return nodeURL
    }

    static func canReuseHostedCredential(host: String, pinnedHost: String?, hasPinnedCA: Bool, hasIdentity: Bool, isTrialIdentity: Bool, hasHostToken: Bool) -> Bool {
        isTrialIdentity && hasIdentity && hasPinnedCA && hasHostToken && pinnedHost?.lowercased() == host.lowercased()
    }

    /// Another device can finish pairing and promote the same machine while
    /// this device is waiting. Both ready and upgraded can finish its original
    /// pairing; expired/destroyed/failed cannot. Only creating keeps polling.
    private func waitForReady(trial: RelayTrialNode, bearer: String) async throws -> RelayTrialNode {
        var current = trial
        var attempts = 0
        while !Self.isReconnectable(current.state) {
            switch current.state {
            case .expired, .destroyed, .failed:
                throw RelayTrialFlowError.machineUnavailable(current.state)
            case .creating, .ready, .upgraded:
                break
            }
            attempts += 1
            guard attempts <= Self.maxReadyPollAttempts else {
                throw RelayTrialFlowError.machineTimedOut
            }
            try await Task.sleep(nanoseconds: pollIntervalNs)
            current = try await client.currentTrial(bearer: bearer)
            guard current.id == trial.id else { throw RelayTrialFlowError.malformedResponse }
        }
        return current
    }

    /// Polls `fetchNodeBlob`, swallowing `.blobPending` (the node hasn't posted
    /// its half of the pairing yet) up to `maxBlobPollAttempts`; any other
    /// thrown error propagates immediately.
    private func waitForNodeBlob(pairingId: String, authToken: String, isAuthorized: @MainActor () -> Bool = { true }) async throws -> (blob: Data, tag: String) {
        var attempts = 0
        while true {
            try Task.checkCancellation()
            guard isAuthorized() else { throw CancellationError() }
            do {
                return try await client.fetchNodeBlob(pairingId: pairingId, authToken: authToken)
            } catch RelayTrialClientError.blobPending {
                attempts += 1
                guard attempts <= Self.maxBlobPollAttempts else {
                    throw RelayTrialFlowError.pairingTimedOut
                }
                try await Task.sleep(nanoseconds: pollIntervalNs)
            }
        }
    }

    private static func encodeDeviceBlob(deviceName: String) throws -> Data {
        guard let data = try? JSONSerialization.data(withJSONObject: ["deviceName": deviceName, "platform": "ios"]) else {
            throw RelayTrialFlowError.malformedResponse
        }
        return data
    }

    private static func writeTemporaryP12(_ data: Data) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-trial-\(UUID().uuidString)", isDirectory: false)
            .appendingPathExtension("p12")
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }

    static func message(for error: Error) -> String {
        if let clientError = error as? RelayTrialClientError {
            return message(for: clientError)
        }
        if let flowError = error as? RelayTrialFlowError {
            return message(for: flowError)
        }
        if let identityError = error as? ClientIdentityStoreError {
            return identityError.errorDescription ?? "The trial machine's credential could not be installed."
        }
        if error is CancellationError {
            return "Trial setup was cancelled."
        }
        return "Relay couldn't set up a trial machine: \(error.localizedDescription)"
    }

    private static func message(for error: RelayTrialClientError) -> String {
        switch error {
        case .unavailable:
            return "Trial machines aren't available right now. Try again soon."
        case .alreadyUsed:
            return "This account's trial was already used."
        case .pairingConflict:
            return "Another setup for this machine is already in progress. Try again in a moment."
        case .tooManyAttempts:
            return "Too many setup attempts in a row. Wait a few minutes, then try again."
        case .capacity:
            return "Relay is at trial capacity right now. Try again in a few minutes."
        case .provisionFailed:
            return "Relay couldn't provision a trial machine. Try again."
        case .noTrial:
            return "No trial machine was found for this account."
        case .blobPending:
            return "Still waiting on the trial machine to finish pairing."
        case .tagMismatch:
            return "The trial machine's credential could not be verified."
        case .reconnectUnavailable:
            return "This hosted machine cannot reconnect a new device right now. Check its connection and try again."
        case .machineNotReady:
            return "The hosted machine is not ready to reconnect. Wait a moment and try again."
        case .hostedAccessUnavailable:
            return "This account does not currently have active hosted-machine access. Check your subscription or contact Relay support."
        case .hostedUpgradeRequired:
            return "This hosted machine needs a Relay service update before a new device can connect. Contact Relay support; your existing machine was not replaced."
        case .server(let status):
            return "Relay returned an unexpected error (\(status))."
        }
    }

    private static func message(for error: RelayTrialFlowError) -> String {
        switch error {
        case .tagMismatch:
            return "The trial machine's credential could not be verified."
        case .machineUnavailable(let state):
            switch state {
            case .expired:
                return "The trial machine expired before it finished starting."
            case .destroyed:
                return "The previous trial machine was deleted. Try instantly again to start a replacement."
            case .failed:
                return "The trial machine failed to start."
            case .creating, .ready, .upgraded:
                return "The trial machine could not be reached."
            }
        case .machineTimedOut:
            return "The trial machine took too long to start. Try again."
        case .pairingTimedOut:
            return "Pairing with the trial machine took too long. Try again."
        case .malformedResponse:
            return "Relay sent back a response the app couldn't understand."
        case .reconnectExpired:
            return "This device's reconnect request expired. Try again to request a new one."
        }
    }
}
