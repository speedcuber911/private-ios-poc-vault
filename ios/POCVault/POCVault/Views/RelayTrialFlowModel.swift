import Foundation

/// Errors that originate in the flow itself (not the network client or the
/// identity store), each with a message ready to surface to the user.
enum RelayTrialFlowError: Error, Equatable {
    case tagMismatch
    case machineUnavailable(RelayTrialNode.State)
    case machineTimedOut
    case pairingTimedOut
    case malformedResponse
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
        case creating
        case waitingForMachine
        case pairing
        case importingIdentity
        case done
        case failed(String)
    }

    @Published private(set) var step: Step = .idle

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
            let created = try await client.createTrial(pairingId: pairingId, pairingSecret: secret, bearer: bearer)

            let deviceBlob = try Self.encodeDeviceBlob(deviceName: deviceName)
            let deviceTag = RelayTrialPairing.blobTag(macKey: macKey, slot: RelayTrialPairing.deviceSlot, blob: deviceBlob)
            try await client.postDeviceBlob(pairingId: pairingId, authToken: authToken, blob: deviceBlob, tag: deviceTag)

            step = .waitingForMachine
            let readyTrial = try await waitForReady(trial: created, bearer: bearer)

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

            nodeStore.adoptTrial(readyTrial)
            step = .done
        } catch {
            step = .failed(Self.message(for: error))
        }
    }

    /// Polls `currentTrial` until it reaches `.ready`. Any other terminal state
    /// (expired/destroyed/failed) throws immediately rather than looping; only
    /// `.creating` keeps polling, bounded by `maxReadyPollAttempts`.
    private func waitForReady(trial: RelayTrialNode, bearer: String) async throws -> RelayTrialNode {
        var current = trial
        var attempts = 0
        while current.state != .ready {
            switch current.state {
            case .expired, .destroyed, .failed:
                throw RelayTrialFlowError.machineUnavailable(current.state)
            case .creating, .ready:
                break
            }
            attempts += 1
            guard attempts <= Self.maxReadyPollAttempts else {
                throw RelayTrialFlowError.machineTimedOut
            }
            try await Task.sleep(nanoseconds: pollIntervalNs)
            current = try await client.currentTrial(bearer: bearer)
        }
        return current
    }

    /// Polls `fetchNodeBlob`, swallowing `.blobPending` (the node hasn't posted
    /// its half of the pairing yet) up to `maxBlobPollAttempts`; any other
    /// thrown error propagates immediately.
    private func waitForNodeBlob(pairingId: String, authToken: String) async throws -> (blob: Data, tag: String) {
        var attempts = 0
        while true {
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
        try data.write(to: url, options: .atomic)
        return url
    }

    private static func message(for error: Error) -> String {
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
                return "The trial machine was destroyed before it finished starting."
            case .failed:
                return "The trial machine failed to start."
            case .creating, .ready:
                return "The trial machine could not be reached."
            }
        case .machineTimedOut:
            return "The trial machine took too long to start. Try again."
        case .pairingTimedOut:
            return "Pairing with the trial machine took too long. Try again."
        case .malformedResponse:
            return "Relay sent back a response the app couldn't understand."
        }
    }
}
