import XCTest
@testable import POCVault

final class TrialPairingTests: XCTestCase {
    // Fixtures generated from product/relayd/src/pairing.mjs (Step 1) — the
    // two implementations must agree byte-for-byte.
    private let secret = "fixture-secret-0123456789"
    private let expectedAuthToken = "9txp4hWq2zfrLpCy9M6n2OeLHkY75Olxy5EwEcvoMeA"
    private let expectedDeviceTag = "Jhp8CDs+kkDm9Z6+VGsqkJjS4mIY+iTrVEWYrNkSFZ0="
    private let expectedP12Passphrase = "69aca1443461ad6836ccad61fa462592adb0dcd9a9b65a26855b62a8494c9cd1"
    private let fixtureBlob = Data("{\"deviceName\":\"Fixture\",\"platform\":\"ios\"}".utf8)

    func testAuthTokenMatchesNodeDerivation() {
        XCTAssertEqual(RelayTrialPairing.authToken(secret: secret), expectedAuthToken)
    }

    func testBlobTagMatchesNodeDerivation() {
        let key = RelayTrialPairing.macKey(secret: secret)
        XCTAssertEqual(RelayTrialPairing.blobTag(macKey: key, slot: RelayTrialPairing.deviceSlot, blob: fixtureBlob), expectedDeviceTag)
        XCTAssertTrue(RelayTrialPairing.verifyTag(macKey: key, slot: RelayTrialPairing.deviceSlot, blob: fixtureBlob, tag: expectedDeviceTag))
        XCTAssertFalse(RelayTrialPairing.verifyTag(macKey: key, slot: RelayTrialPairing.nodeSlot, blob: fixtureBlob, tag: expectedDeviceTag))
    }

    func testP12PassphraseMatchesNodeDerivation() {
        XCTAssertEqual(RelayTrialPairing.p12Passphrase(secret: secret), expectedP12Passphrase)
    }

    func testGenerateSecretShape() {
        let s = RelayTrialPairing.generateSecret()
        XCTAssertNil(s.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        XCTAssertGreaterThanOrEqual(s.count, 32)
        XCTAssertNotEqual(RelayTrialPairing.generateSecret(), s)
    }

    func testTrialNodeDecoding() throws {
        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1000,"expiresAt":2000}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
        XCTAssertEqual(trial.state, .ready)
        XCTAssertEqual(trial.nodeURL, URL(string: "https://node-0011223344556677.tun.test"))
    }

    func testTrialNodeDecodesUpgradedState() throws {
        let json = #"{"id":"t1","state":"upgraded","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1000,"expiresAt":2000}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
        XCTAssertEqual(trial.state, .upgraded)
        XCTAssertEqual(trial.nodeURL, URL(string: "https://node-0011223344556677.tun.test"))
    }

    func testTrialEnvelopeDecoding() throws {
        let json = #"{"trial":{"id":"t1","state":"creating","nodeId":null,"sni":null,"createdAt":1,"expiresAt":2}}"#
        let trial = try RelayTrialClient.decodeTrialEnvelope(Data(json.utf8))
        XCTAssertEqual(trial.state, .creating)
        XCTAssertNil(trial.nodeURL)
    }

    /// 409 is not one condition and 429 is not "unexpected": pairing conflicts
    /// and the 5-live-sessions cap each need their own actionable copy.
    func testTrialErrorMappingDiscriminatesConflictsAndRateLimiting() {
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: "trial_already_used"), .alreadyUsed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: "slot_already_written"), .pairingConflict)
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: "node_exists"), .pairingConflict)
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: nil), .pairingConflict)
        XCTAssertEqual(RelayTrialClient.mapError(status: 429, code: "too_many_pairing_sessions"), .tooManyAttempts)
    }

    func testTrialErrorMapping() {
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: "trial_already_used"), .alreadyUsed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 503, code: "trial_capacity"), .capacity)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "trial_unavailable"), .unavailable)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "no_trial"), .noTrial)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "not_posted_yet"), .blobPending)
        XCTAssertEqual(RelayTrialClient.mapError(status: 502, code: "provision_failed"), .provisionFailed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 500, code: nil), .server(status: 500))
    }

    @MainActor
    func testNodeStorePersistsAndRestoresTrial() async throws {
        let suite = "trial-node-store-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1,"expiresAt":2}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))

        let store = RelayNodeStore(defaults: defaults)
        XCTAssertNil(store.activeNodeURL)
        store.adoptTrial(trial)
        XCTAssertEqual(store.activeNodeURL, URL(string: "https://node-0011223344556677.tun.test"))

        let restored = RelayNodeStore(defaults: defaults)
        XCTAssertEqual(restored.trial?.id, "t1")
        XCTAssertEqual(restored.activeNodeURL, store.activeNodeURL)

        restored.clear()
        XCTAssertNil(RelayNodeStore(defaults: defaults).activeNodeURL)
    }

    func testTrialRemainingDescription() throws {
        let json = #"{"id":"t","state":"ready","nodeId":"n","sni":"s.tun.test","createdAt":0,"expiresAt":172800000}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
        XCTAssertEqual(trial.remainingDescription(now: Date(timeIntervalSince1970: 0)), "2 days left")
        XCTAssertEqual(trial.remainingDescription(now: Date(timeIntervalSince1970: 169_200)), "1 hour left")
        XCTAssertEqual(trial.remainingDescription(now: Date(timeIntervalSince1970: 200_000)), "Trial expired")
    }

    func testUpgradedRemainingDescriptionIsNotACountdown() throws {
        let trial = try Self.upgradedTrial()
        let description = trial.remainingDescription(now: Date(timeIntervalSince1970: 0))
        XCTAssertEqual(description, "")
        XCTAssertFalse(
            description.contains("left"),
            "upgraded must not show a TTL countdown, got: \(description)"
        )
    }

    @MainActor
    func testTrialFlowSurfacesAlreadyUsedFailure() async {
        // Dead-endpoint client (house idiom): every call throws .server/.connection,
        // so the flow must land in .failed with a message, never hang.
        let client = RelayTrialClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let flow = RelayTrialFlowModel(
            client: client,
            identityStore: ClientIdentityStore(),
            nodeStore: RelayNodeStore(defaults: UserDefaults(suiteName: "trial-flow-tests")!),
            pollIntervalNs: 1
        )
        await flow.start(bearer: "b", deviceName: "Test")
        guard case .failed = flow.step else {
            return XCTFail("expected .failed, got \(flow.step)")
        }
    }

    // MARK: - Pinned node CA (C1)

    /// A trial machine sits behind a TLS-passthrough broker, so its certificate
    /// is signed by the node's own CA — the CA that ships inside the pairing
    /// PKCS#12 next to the client leaf. The store must surface that CA and never
    /// the leaf.
    func testTrialPKCS12YieldsTheSelfSignedCANotTheClientLeaf() throws {
        let ca = try XCTUnwrap(SecCertificateCreateWithData(nil, Self.caDER as CFData))
        let leaf = try XCTUnwrap(SecCertificateCreateWithData(nil, Self.leafDER as CFData))

        XCTAssertTrue(ClientIdentityStore.isSelfSigned(ca))
        XCTAssertFalse(ClientIdentityStore.isSelfSigned(leaf))

        let picked = ClientIdentityStore.caCertificate(in: [leaf, ca], leafData: Self.leafDER)
        XCTAssertEqual(picked.map { SecCertificateCopyData($0) as Data }, Self.caDER)

        // A BYO p12 carries only its own leaf: nothing to pin, and no error.
        XCTAssertNil(ClientIdentityStore.caCertificate(in: [leaf], leafData: Self.leafDER))
        XCTAssertNil(ClientIdentityStore.caCertificate(in: [], leafData: Self.leafDER))
    }

    /// The decision half of pinning: only the trial host is evaluated against the
    /// node CA. The personal install keeps the system trust store even while a
    /// pinned CA is held, or the BYO path would break.
    func testServerTrustPinsTheTrialHostAndNothingElse() {
        let host = "node-0011223344556677.tun.test"

        XCTAssertEqual(
            RelayServerTrust.decision(challengeHost: host, pinnedHost: host, hasPinnedCA: true),
            .pinned
        )
        XCTAssertEqual(
            RelayServerTrust.decision(challengeHost: host.uppercased(), pinnedHost: host, hasPinnedCA: true),
            .pinned
        )
        XCTAssertEqual(
            RelayServerTrust.decision(
                challengeHost: "codex.pocs.conformal.live",
                pinnedHost: host,
                hasPinnedCA: true
            ),
            .systemDefault
        )
        XCTAssertEqual(
            RelayServerTrust.decision(challengeHost: "other.tun.test", pinnedHost: host, hasPinnedCA: true),
            .systemDefault
        )
        XCTAssertEqual(
            RelayServerTrust.decision(challengeHost: host, pinnedHost: nil, hasPinnedCA: true),
            .systemDefault
        )
        XCTAssertEqual(
            RelayServerTrust.decision(challengeHost: host, pinnedHost: "  ", hasPinnedCA: true),
            .systemDefault
        )
        XCTAssertEqual(
            RelayServerTrust.decision(challengeHost: host, pinnedHost: host, hasPinnedCA: false),
            .systemDefault
        )
    }

    /// The CA is public material persisted next to the trial record, so it has to
    /// survive a relaunch — and disappear on sign-out (I7).
    func testPinnedTrialMaterialPersistsAndIsPurgedOnSignOut() throws {
        let suite = "identity-pinning-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let ca = try XCTUnwrap(SecCertificateCreateWithData(nil, Self.caDER as CFData))

        let store = ClientIdentityStore(defaults: defaults)
        XCTAssertNil(store.pinnedCACertificate)
        XCTAssertNil(store.pinnedHost)
        XCTAssertFalse(store.hasTrialIssuedIdentity)

        store.pinTrialMaterial(caCertificate: ca, host: "Node-0011223344556677.TUN.test")
        XCTAssertEqual(store.pinnedHost, "node-0011223344556677.tun.test")
        XCTAssertTrue(store.hasTrialIssuedIdentity)

        let restored = ClientIdentityStore(defaults: defaults)
        XCTAssertEqual(restored.pinnedHost, "node-0011223344556677.tun.test")
        XCTAssertEqual(
            restored.pinnedCACertificate.map { SecCertificateCopyData($0) as Data },
            Self.caDER
        )

        restored.discardTrialMaterial()
        let afterSignOut = ClientIdentityStore(defaults: defaults)
        XCTAssertNil(afterSignOut.pinnedCACertificate)
        XCTAssertNil(afterSignOut.pinnedHost)
        XCTAssertFalse(afterSignOut.hasTrialIssuedIdentity)
    }

    /// The other direction of I7: a BYO import pins nothing and is never marked
    /// trial-issued, so sign-out has no identity of the user's own to destroy.
    func testBYOImportNeverPinsAndIsNeverMarkedTrialIssued() throws {
        let suite = "identity-byo-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let ca = try XCTUnwrap(SecCertificateCreateWithData(nil, Self.caDER as CFData))

        let store = ClientIdentityStore(defaults: defaults)
        store.pinTrialMaterial(caCertificate: ca, host: nil)
        store.pinTrialMaterial(caCertificate: nil, host: "   ")

        XCTAssertNil(store.pinnedCACertificate)
        XCTAssertNil(store.pinnedHost)
        XCTAssertFalse(store.hasTrialIssuedIdentity)

        store.discardTrialMaterial()
        XCTAssertFalse(ClientIdentityStore(defaults: defaults).hasTrialIssuedIdentity)
    }

    // MARK: - Adoption repoints the whole app (C2/M4)

    func testCodexClientRetargetsWithoutRebuilding() throws {
        let personal = try XCTUnwrap(URL(string: "https://codex.pocs.conformal.live"))
        let trial = try XCTUnwrap(URL(string: "https://node-0011223344556677.tun.test"))
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "codex-client-retarget-tests"))
        defaults.removePersistentDomain(forName: "codex-client-retarget-tests")

        let client = CodexClient(baseURL: personal, identityStore: ClientIdentityStore(defaults: defaults))
        XCTAssertEqual(client.baseURL, personal)

        client.retarget(baseURL: trial)
        XCTAssertEqual(client.baseURL, trial)
        XCTAssertEqual(
            CodexClient.resolvedArtifactURL("/v1/codex/fs/file", baseURL: client.baseURL)?.host,
            "node-0011223344556677.tun.test"
        )

        client.retarget(baseURL: personal)
        XCTAssertEqual(client.baseURL, personal)
    }

    // MARK: - Trial refresh (C3)

    @MainActor
    func testTrialRefreshForgetsTheMachineOnlyWhenTheServerSaysSo() throws {
        let suite = "trial-refresh-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))

        for failure in Self.transientRefreshFailures {
            defaults.removePersistentDomain(forName: suite)
            let store = RelayNodeStore(defaults: defaults)
            store.adoptTrial(try Self.readyTrial())

            store.applyRefresh(.failure(failure))

            XCTAssertEqual(store.trial?.id, "t1", "kept for \(failure)")
            XCTAssertEqual(
                store.activeNodeURL,
                URL(string: "https://node-0011223344556677.tun.test"),
                "kept for \(failure)"
            )
            // And it is still there on the next launch.
            XCTAssertEqual(RelayNodeStore(defaults: defaults).trial?.id, "t1")
        }

        defaults.removePersistentDomain(forName: suite)
        let store = RelayNodeStore(defaults: defaults)
        store.adoptTrial(try Self.readyTrial())
        store.applyRefresh(.failure(RelayTrialClientError.noTrial))
        XCTAssertNil(store.trial)
        XCTAssertNil(store.activeNodeURL)
        XCTAssertNil(RelayNodeStore(defaults: defaults).trial)
    }

    // This test used to assert the opposite — that a refresh never drops the
    // node URL — and it was renamed with the behaviour it pinned. updateTrial
    // now follows the server's answer about whether there is a usable machine
    // at all: an expired/destroyed/failed trial clears the pointer, because a
    // dead one is worse than none. Keeping it made the phone dial a destroyed
    // node forever while the banner read "Trial expired", with every request
    // failing at TLS and nothing connecting the two. `hasMachine` can now route
    // to the trial flow instead.
    @MainActor
    func testTrialRefreshClearsTheNodeURLOnceTheTrialIsNoLongerUsable() throws {
        let suite = "trial-refresh-success-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let store = RelayNodeStore(defaults: defaults)
        store.adoptTrial(try Self.readyTrial())
        store.applyRefresh(.success(try Self.expiredTrial()))

        XCTAssertEqual(store.trial?.state, .expired)
        XCTAssertNil(store.activeNodeURL, "an expired trial's node is gone; dialling it can only fail at TLS")
        XCTAssertFalse(store.hasMachine, "and with no usable machine the app must route to the trial flow")
        XCTAssertEqual(RelayNodeStore(defaults: defaults).trial?.state, .expired)
    }

    // The other half of the same rule, which nothing covered: while the trial
    // IS usable the pointer must be kept, or a refresh would knock a working
    // machine out from under the app.
    @MainActor
    func testTrialRefreshKeepsTheNodeURLWhileTheTrialIsUsable() throws {
        let suite = "trial-refresh-usable-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let store = RelayNodeStore(defaults: defaults)
        store.adoptTrial(try Self.readyTrial())
        store.applyRefresh(.success(try Self.readyTrial()))

        XCTAssertEqual(store.trial?.state, .ready)
        XCTAssertEqual(store.activeNodeURL, URL(string: "https://node-0011223344556677.tun.test"))
        XCTAssertTrue(store.hasMachine)
    }

    @MainActor
    func testTrialRefreshOfUpgradedKeepsTheNodeURL() throws {
        let suite = "trial-refresh-upgraded-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let store = RelayNodeStore(defaults: defaults)
        store.adoptTrial(try Self.readyTrial())
        store.applyRefresh(.success(try Self.upgradedTrial()))

        XCTAssertEqual(store.trial?.state, .upgraded)
        XCTAssertEqual(store.activeNodeURL, URL(string: "https://node-0011223344556677.tun.test"))
        XCTAssertTrue(store.hasMachine)

        let restored = RelayNodeStore(defaults: defaults)
        XCTAssertEqual(restored.trial?.state, .upgraded)
        XCTAssertEqual(restored.activeNodeURL, URL(string: "https://node-0011223344556677.tun.test"))
    }

    @MainActor
    func testTrialRefreshNoTrialStillClearsAnUpgradedMachine() throws {
        let suite = "trial-refresh-upgraded-no-trial-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let store = RelayNodeStore(defaults: defaults)
        store.adoptTrial(try Self.readyTrial())
        store.applyRefresh(.success(try Self.upgradedTrial()))
        store.applyRefresh(.failure(RelayTrialClientError.noTrial))

        XCTAssertNil(store.trial)
        XCTAssertNil(store.activeNodeURL)
        XCTAssertNil(RelayNodeStore(defaults: defaults).trial)
    }

    func testStatusBannerVisibilityByTrialState() throws {
        XCTAssertTrue(try Self.trial(state: "creating").showsStatusBanner)
        XCTAssertTrue(try Self.readyTrial().showsStatusBanner)
        XCTAssertTrue(try Self.expiredTrial().showsStatusBanner)
        XCTAssertFalse(try Self.upgradedTrial().showsStatusBanner)
        XCTAssertFalse(try Self.trial(state: "destroyed").showsStatusBanner)
        XCTAssertFalse(try Self.trial(state: "failed").showsStatusBanner)
    }

    func testTrialMachineSectionIsHiddenWhenUpgraded() throws {
        XCTAssertFalse(try Self.upgradedTrial().showsTrialMachineSection)
        XCTAssertTrue(try Self.readyTrial().showsTrialMachineSection)
        XCTAssertTrue(try Self.expiredTrial().showsTrialMachineSection)
        XCTAssertTrue(try Self.trial(state: "creating").showsTrialMachineSection)
    }

    // MARK: - Fixtures

    /// Every non-authoritative failure shape the foreground refresh can hit:
    /// offline, an auth/5xx status, and a response the app cannot decode.
    private static let transientRefreshFailures: [Error] = [
        URLError(.notConnectedToInternet),
        URLError(.cannotFindHost),
        RelayTrialClientError.server(status: 500),
        RelayTrialClientError.server(status: 401),
        RelayTrialClientError.capacity,
        DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "unknown state"))
    ]

    private static func readyTrial() throws -> RelayTrialNode {
        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1,"expiresAt":2}"#
        return try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
    }

    private static func expiredTrial() throws -> RelayTrialNode {
        let json = #"{"id":"t1","state":"expired","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1,"expiresAt":2}"#
        return try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
    }

    /// Far-future `expiresAt` so a mistaken countdown would read "2 days left".
    private static func upgradedTrial() throws -> RelayTrialNode {
        let json = #"{"id":"t1","state":"upgraded","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":0,"expiresAt":172800000}"#
        return try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
    }

    private static func trial(state: String) throws -> RelayTrialNode {
        let json = #"{"id":"t1","state":"\#(state)","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1,"expiresAt":2}"#
        return try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
    }

    /// Throwaway certificates generated for this test only — public DER, no keys.
    /// `ca` is self-signed; `leaf` (CN=iphone) is issued by it, mirroring the
    /// shape of the PKCS#12 relayd builds with `-certfile <ca.pem>`.
    private static let caDER = Data(base64Encoded:
        "MIIDGzCCAgOgAwIBAgIUcArD1wHmThQssQq/0jDo1KlXd5gwDQYJKoZIhvcNAQELBQAwHTEb" +
        "MBkGA1UEAwwSUmVsYXkgVGVzdCBOb2RlIENBMB4XDTI2MDgxMTE2MTgzNFoXDTQ2MDgwNjE2" +
        "MTgzNFowHTEbMBkGA1UEAwwSUmVsYXkgVGVzdCBOb2RlIENBMIIBIjANBgkqhkiG9w0BAQEF" +
        "AAOCAQ8AMIIBCgKCAQEAxVgZtJ2dsDKByJ0OPNOQG1px0cIgBOrEPg07edDzoPDOc+6qXxSe" +
        "6eMYm6nskdj/ErTTay8YC3qEO1UxlymlMmNtw8HwKX7JNif7I5rdvHtMihcV9Rm3zMrSEkzD" +
        "8OEBrK+dW2lnKXS7GXfP3D55tWwOGIB/gwoFSN1fCRsTlCQjvs0XOyLuV7tJZZiX03pdDUd3" +
        "N0e4DoVSc+H2ax0ytlyept6qxOdBgk56AbocjWpn+8pulYGwZ2qYNpRLjviUteLGUhrwg7/+" +
        "zrhFKwBs+YJ7muJwwAEJF5ffIUZo8lZoSbE//lLTi6MIGyINHCHxwv3GbGo7ooKC/2rpYJVv" +
        "bwIDAQABo1MwUTAdBgNVHQ4EFgQUGdTiTwTPjq0EbKx6xBzZBQ8DYVowHwYDVR0jBBgwFoAU" +
        "GdTiTwTPjq0EbKx6xBzZBQ8DYVowDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC" +
        "AQEAcNUTYC0x1hL6ZNL011mKOXW36xObnoETzy9VTw3lzUFfizZQsrNCBpuSZGOmEcW82797" +
        "V/Ui2xWGil3K6qorNNgPp6/bGWSwH6qmYFI3JtLl9q5vN2gnCKXCMxm2JkwGDZ39z8UZSWUP" +
        "bApzFUp7jfWAExf0zKiySLR4uZCW1c0Eajq1ypWIEyxfG75C0fPwSl7Xvl1NxkfjiEyUbpYR" +
        "bz5qxnmu5zyOAMLNmxJBannga+pp/as0dXoOaskq3AJi9YlgjyADrZQO/gzOEnZxve5FQSAi" +
        "mInUNKGgMC8M2bsv6riH8NNZNVTB5fhr2FftY6tln0rmAemNlWnuNCUaEg=="
    )!

    private static let leafDER = Data(base64Encoded:
        "MIIC/jCCAeagAwIBAgIUbB1ywJSJ5yuGY0G/nwna3vyWoLswDQYJKoZIhvcNAQELBQAwHTEb" +
        "MBkGA1UEAwwSUmVsYXkgVGVzdCBOb2RlIENBMB4XDTI2MDgxMTE2MTgzNFoXDTM2MDgwODE2" +
        "MTgzNFowETEPMA0GA1UEAwwGaXBob25lMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC" +
        "AQEAoRySTDNM5AL/3n5E4WOLMFRfCFRQQZVBqL3/LzFLn0bN2ZdZMOXtN+EvKU+lDIi5H7Wq" +
        "j5hOwznx8hKmrxqRYY3nCJl2Hc930UuWI+TtEogf4uhyS6NgWmj0O24KccJnd1puXkrm0izs" +
        "4yXhUtcv7PAX0p17xLW+XRmjKJDG+PywbSHfW/1LvyxsFL/HBAwwzown+XrnoESIG3v2m5YS" +
        "Zy4RW6EDHBIxg7MFrvsEHIjU8rJn8CQNdHp+CTvWUgP8T4IHRZCAcg6tob+dlgWPXaygWbhB" +
        "zPTlUAVDylX1ZWLTtawQR07GbeyXNny7+MjZSAgwO15JtabwvKb5xScYqwIDAQABo0IwQDAd" +
        "BgNVHQ4EFgQUl4Wq2xzC4GgYWUw03jUuxy+p9uYwHwYDVR0jBBgwFoAUGdTiTwTPjq0EbKx6" +
        "xBzZBQ8DYVowDQYJKoZIhvcNAQELBQADggEBAAvYjoBF/dT+xU74F52BDuDHO8P5Q126a+M3" +
        "djpyd+SBU/1YwtJ9HT88yVNxGU0SQifjVcvytTA1xGndcnATp3mF5QMRqPlOVTTwAfqJhh7a" +
        "LFn2mkWDEHJ3dkYPiScS+i2+ygyYlnPybfubc+FfnSKgnoR3lyw3tJ+3jBCWgQ+hCCsoCYSQ" +
        "HXZT26m7mxdxG2J6R2G7kPXBNBPmBwnj0Wr15Ct9lM7VQXVnB1RoRWj2DvVW0MmI1KJrvP1G" +
        "grFZWipp+F6oFJTF0xJcChEcb0J99BkiUEvVLAXsaJA85t9TaeWprQHCLq+CCIjHYXCtthEs" +
        "veVKJWDQFXp5y3QZeXw="
    )!
}

// MARK: - trial_already_used is three situations, not one

/// Canned-response transport, so the flow can be driven through the exact
/// server answers a returning user gets without a live control plane.
final class StubTrialURLProtocol: URLProtocol {
    /// path -> (status, json). Set per test; read on the URLSession's queue.
    nonisolated(unsafe) static var routes: [String: (Int, String)] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        let (status, body) = Self.routes[path] ?? (404, "{\"error\":\"not_found\"}")
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

private func stubbedTrialClient() -> RelayTrialClient {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubTrialURLProtocol.self]
    return RelayTrialClient(baseURL: URL(string: "https://cloud.test")!, session: URLSession(configuration: config))
}

private func trialJSON(state: String, sni: String?) -> String {
    let sniField = sni.map { "\"\($0)\"" } ?? "null"
    return """
    {"trial":{"id":"t1","state":"\(state)","nodeId":"node-1","sni":\(sniField),\
    "createdAt":1000,"expiresAt":9999999999999}}
    """
}

/// The bug this covers: `start()` ran straight into `createTrial` on every
/// entry, so a returning user — reinstall, second device, cleared node store —
/// dead-ended on "This account's trial was already used". True, and useless:
/// it says nothing about whether their machine is alive, which is the only
/// thing they wanted to know.
@MainActor
func makeFlow(_ suite: String) -> (RelayTrialFlowModel, RelayNodeStore) {
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    let nodeStore = RelayNodeStore(defaults: defaults)
    let flow = RelayTrialFlowModel(
        client: stubbedTrialClient(),
        identityStore: ClientIdentityStore(),
        nodeStore: nodeStore,
        pollIntervalNs: 1
    )
    return (flow, nodeStore)
}

extension TrialPairingTests {
    @MainActor
    func testAlreadyUsedWithALiveMachineExplainsTheMissingCredential() async {
        StubTrialURLProtocol.routes = [
            "/v1/pairing/sessions": (201, "{\"pairingId\":\"p1\",\"expiresAt\":9999999999999}"),
            "/v1/trial-nodes": (409, "{\"error\":\"trial_already_used\"}"),
            "/v1/trial-nodes/current": (200, trialJSON(state: "ready", sni: "node-1.tun.test")),
        ]
        let (flow, nodeStore) = makeFlow("trial-adopt-live")

        await flow.start(bearer: "b", deviceName: "Test")

        guard case .failed(let message) = flow.step else {
            return XCTFail("expected .failed, got \(flow.step)")
        }
        // The machine is up, so the message must be about THIS DEVICE's
        // credential, not about the trial being spent.
        XCTAssertTrue(message.contains("still running"), "got: \(message)")
        XCTAssertTrue(message.contains("credential"), "got: \(message)")
        XCTAssertNil(nodeStore.trial, "a machine this device cannot authenticate to must not be adopted")
    }

    @MainActor
    func testAlreadyUsedWithADestroyedMachineDoesNotBurnTheLifetimeCap() async {
        StubTrialURLProtocol.routes = [
            "/v1/pairing/sessions": (201, "{\"pairingId\":\"p1\",\"expiresAt\":9999999999999}"),
            "/v1/trial-nodes": (409, "{\"error\":\"trial_already_used\"}"),
            "/v1/trial-nodes/current": (200, trialJSON(state: "destroyed", sni: nil)),
        ]
        let (flow, nodeStore) = makeFlow("trial-adopt-destroyed")

        await flow.start(bearer: "b", deviceName: "Test")

        guard case .failed(let message) = flow.step else {
            return XCTFail("expected .failed, got \(flow.step)")
        }
        XCTAssertTrue(message.contains("deleted"), "the state the user is actually in must be named: \(message)")
        XCTAssertTrue(message.contains("replacement"), "got: \(message)")
        XCTAssertFalse(
            message.contains("can only be created once"),
            "a deleted machine must not be described as a lifetime cap: \(message)"
        )
        XCTAssertNil(nodeStore.trial)
    }

    @MainActor
    func testAlreadyUsedWithAnExpiredMachineNamesTheSpentTrial() async {
        StubTrialURLProtocol.routes = [
            "/v1/pairing/sessions": (201, "{\"pairingId\":\"p1\",\"expiresAt\":9999999999999}"),
            "/v1/trial-nodes": (409, "{\"error\":\"trial_already_used\"}"),
            "/v1/trial-nodes/current": (200, trialJSON(state: "expired", sni: nil)),
        ]
        let (flow, nodeStore) = makeFlow("trial-adopt-expired")

        await flow.start(bearer: "b", deviceName: "Test")

        guard case .failed(let message) = flow.step else {
            return XCTFail("expected .failed, got \(flow.step)")
        }
        XCTAssertTrue(message.contains("expired"), "got: \(message)")
        XCTAssertNil(nodeStore.trial)
    }
}
