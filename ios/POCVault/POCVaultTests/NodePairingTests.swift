import CryptoKit
import Security
import XCTest
@testable import POCVault

final class NodePairingTests: XCTestCase {
    // MARK: - Derivations must agree with relayd, byte for byte

    // Fixtures generated from product/relayd/src/pairing.mjs. These are wire
    // values: if one of these assertions has to be "updated", every already
    // paired device has just been locked out of its machine.
    private let secret = "fixture-secret-0123456789"
    private let expectedAuthToken = "9txp4hWq2zfrLpCy9M6n2OeLHkY75Olxy5EwEcvoMeA"
    private let expectedDeviceTag = "Jhp8CDs+kkDm9Z6+VGsqkJjS4mIY+iTrVEWYrNkSFZ0="
    private let expectedP12Passphrase = "69aca1443461ad6836ccad61fa462592adb0dcd9a9b65a26855b62a8494c9cd1"
    private let fixtureBlob = Data("{\"deviceName\":\"Fixture\",\"platform\":\"ios\"}".utf8)

    func testAuthTokenMatchesNodeDerivation() {
        XCTAssertEqual(RelayPairing.authToken(secret: secret), expectedAuthToken)
    }

    func testBlobTagMatchesNodeDerivation() {
        let key = RelayPairing.macKey(secret: secret)
        XCTAssertEqual(
            RelayPairing.blobTag(macKey: key, slot: RelayPairing.deviceSlot, blob: fixtureBlob),
            expectedDeviceTag
        )
    }

    /// A tag is bound to its slot. Replaying the device blob's tag into the
    /// node slot is the substitution this MAC exists to stop.
    func testTagVerificationAcceptsItsOwnSlotAndRejectsEveryOtherChange() {
        let key = RelayPairing.macKey(secret: secret)
        XCTAssertTrue(RelayPairing.verifyTag(
            macKey: key, slot: RelayPairing.deviceSlot, blob: fixtureBlob, tag: expectedDeviceTag
        ))
        XCTAssertFalse(RelayPairing.verifyTag(
            macKey: key, slot: RelayPairing.nodeSlot, blob: fixtureBlob, tag: expectedDeviceTag
        ))
        XCTAssertFalse(RelayPairing.verifyTag(
            macKey: key, slot: RelayPairing.deviceSlot, blob: Data("tampered".utf8), tag: expectedDeviceTag
        ))
        XCTAssertFalse(RelayPairing.verifyTag(
            macKey: RelayPairing.macKey(secret: "another-secret"),
            slot: RelayPairing.deviceSlot, blob: fixtureBlob, tag: expectedDeviceTag
        ))
        XCTAssertFalse(RelayPairing.verifyTag(
            macKey: key, slot: RelayPairing.deviceSlot, blob: fixtureBlob, tag: "not base64 @@"
        ))
    }

    func testP12PassphraseMatchesNodeDerivation() {
        XCTAssertEqual(RelayPairing.p12Passphrase(secret: secret), expectedP12Passphrase)
    }

    /// The device bearer token and the PKCS#12 passphrase come from the same
    /// secret under different labels, so neither may ever equal the other and
    /// both must be stable hex digests.
    func testDeviceTokenIsItsOwnLabelledDerivation() {
        let token = RelayPairing.deviceToken(secret: secret)
        XCTAssertEqual(token.count, 64)
        XCTAssertTrue(token.allSatisfy(\.isHexDigit))
        XCTAssertNotEqual(token, RelayPairing.p12Passphrase(secret: secret))
        XCTAssertEqual(token, RelayPairing.deviceToken(secret: secret))
        XCTAssertNotEqual(token, RelayPairing.deviceToken(secret: secret + "x"))
    }

    // MARK: - QR fragment parsing

    func testParsesTheFullUniversalLink() throws {
        let invite = try RelayPairingInvite.parse(Self.defaultLink)
        XCTAssertEqual(invite.nodeID, "node-abc")
        XCTAssertEqual(invite.nodeName, "Studio Linux")
        XCTAssertEqual(invite.secret, "tok3n-value")
        XCTAssertEqual(invite.pairEndpoint.absoluteString, "https://192.168.1.20:8443/v1/pair")
        XCTAssertEqual(invite.apiBaseURL.absoluteString, "https://192.168.1.20:8443")
        XCTAssertEqual(invite.caFingerprint, Self.caFingerprint)
    }

    /// The scanner hands over whatever the QR encodes; a user may paste only
    /// the fragment, with or without its `#`.
    func testAcceptsABareFragmentWithOrWithoutTheHash() throws {
        let fragment = String(Self.defaultLink.split(separator: "#", maxSplits: 1).last!)
        XCTAssertEqual(try RelayPairingInvite.parse(fragment).nodeID, "node-abc")
        XCTAssertEqual(try RelayPairingInvite.parse("#" + fragment).nodeID, "node-abc")
    }

    func testIPv6LiteralsAndPortsSurviveParsing() throws {
        let invite = try RelayPairingInvite.parse(Self.makeLink(
            api: "https://[fd00::1]:8443",
            pair: "https://[fd00::1]:8443/v1/pair"
        ))
        // URL unwraps the brackets, matching what URLAuthenticationChallenge
        // reports, which is what pinning compares against.
        XCTAssertEqual(invite.apiBaseURL.host, "fd00::1")
        XCTAssertEqual(invite.apiBaseURL.port, 8443)
        XCTAssertEqual(invite.pairEndpoint.absoluteString, "https://[fd00::1]:8443/v1/pair")
    }

    func testMissingFieldsAreNamedRatherThanSwallowed() {
        for (dropped, description) in [
            ("n", "the machine id"),
            ("t", "the pairing token"),
            ("p", "the pairing address"),
            ("a", "the machine address"),
            ("f", "the CA fingerprint")
        ] {
            let link = Self.makeLink(dropping: dropped)
            XCTAssertThrowsError(try RelayPairingInvite.parse(link), "dropping \(dropped)") { error in
                guard case RelayPairingInviteError.missingFields(let fields) = error else {
                    return XCTFail("expected missingFields for \(dropped), got \(error)")
                }
                XCTAssertEqual(fields, [description])
            }
        }
    }

    /// A payload with no pin cannot be paired with at all: the first
    /// connection would have nothing to authenticate the machine against.
    func testAFingerprintThatIsNotThirtyTwoBytesIsRejected() {
        XCTAssertThrowsError(try RelayPairingInvite.parse(Self.makeLink(fingerprint: "too-short"))) { error in
            XCTAssertEqual(error as? RelayPairingInviteError, .invalidFingerprint)
        }
    }

    func testJunkIsReportedAsJunkAndNotAsMissingFields() {
        XCTAssertThrowsError(try RelayPairingInvite.parse("")) {
            XCTAssertEqual($0 as? RelayPairingInviteError, .empty)
        }
        XCTAssertThrowsError(try RelayPairingInvite.parse("   ")) {
            XCTAssertEqual($0 as? RelayPairingInviteError, .empty)
        }
        XCTAssertThrowsError(try RelayPairingInvite.parse("https://example.com/whatever")) {
            XCTAssertEqual($0 as? RelayPairingInviteError, .notAPairingCode)
        }
        XCTAssertThrowsError(try RelayPairingInvite.parse("WIFI:S:home;T:WPA;P:hunter2;;")) {
            XCTAssertEqual($0 as? RelayPairingInviteError, .notAPairingCode)
        }
        XCTAssertThrowsError(try RelayPairingInvite.parse(Self.makeLink(version: "2"))) {
            XCTAssertEqual($0 as? RelayPairingInviteError, .unsupportedVersion("2"))
        }
    }

    // MARK: - Manual entry

    /// The confirmation code is not a credential and the phone must not treat
    /// it as one. Eight characters from a 32-symbol alphabet is ~40 bits, and
    /// it would be the MAC key for the whole exchange — brute-forceable offline
    /// from one captured blob and tag. relayd stopped matching it; so does this.
    func testTheConfirmationCodeIsNeverAcceptedAsAPairingToken() {
        XCTAssertNil(RelayPairingInvite.normalizeToken("ABCD-EFGH"))
        XCTAssertTrue(RelayPairingInvite.looksLikeVerificationCode("ABCD-EFGH"))
        XCTAssertTrue(RelayPairingInvite.looksLikeVerificationCode("abcd efgh"))
        // 0/O/1/I are outside relayd's alphabet, so these are not codes.
        XCTAssertFalse(RelayPairingInvite.looksLikeVerificationCode("ABCD-EFG0"))
        XCTAssertFalse(RelayPairingInvite.looksLikeVerificationCode("ABCD-EFGI"))

        XCTAssertEqual(
            RelayPairingInvite.normalizeToken("  s0Me-Long_TOKEN-value-24by  "),
            "s0Me-Long_TOKEN-value-24by"
        )
        XCTAssertNil(RelayPairingInvite.normalizeToken("short"))
        XCTAssertNil(RelayPairingInvite.normalizeToken("has spaces in the middle here"))
        XCTAssertNil(RelayPairingInvite.normalizeToken(""))
    }

    /// A user who types the code into the token field is making an
    /// understandable mistake and is told which value to use — by name, without
    /// spending a request to find out.
    @MainActor
    func testManualEntryNamesTheFieldAtFaultIncludingTheCodeForTokenMixUp() throws {
        let model = try makeModel()
        XCTAssertEqual(model.manualEntryProblem, .missingNodeURL)

        model.manualNodeURL = "not a url"
        XCTAssertEqual(model.manualEntryProblem, .invalidNodeURL)

        model.manualNodeURL = "https://192.168.1.20:8443"
        XCTAssertEqual(model.manualEntryProblem, .missingToken)

        model.manualToken = "ABCD-EFGH"
        XCTAssertEqual(model.manualEntryProblem, .verificationCodeInTokenField)
        let advice = try XCTUnwrap(model.manualEntryProblem?.message)
        XCTAssertTrue(advice.contains("confirmation code"))
        XCTAssertTrue(advice.contains("pairing token"))

        model.manualToken = "!!!!"
        XCTAssertEqual(model.manualEntryProblem, .invalidToken)

        model.manualToken = "s0Me-Long_TOKEN-value-24by"
        XCTAssertEqual(model.manualEntryProblem, .missingFingerprint)

        model.manualFingerprint = "deadbeef"
        XCTAssertEqual(model.manualEntryProblem, .invalidFingerprint)

        model.manualFingerprint = Self.caFingerprint
        XCTAssertNil(model.manualEntryProblem)
        XCTAssertTrue(model.isManualEntryComplete)
    }

    func testPairEndpointDerivationKeepsPortsAndPathPrefixes() throws {
        let plain = try XCTUnwrap(URL(string: "https://192.168.1.20:8443"))
        XCTAssertEqual(
            RelayPairingInvite.defaultPairEndpoint(nodeURL: plain)?.absoluteString,
            "https://192.168.1.20:8443/v1/pair"
        )
        let prefixed = try XCTUnwrap(URL(string: "https://box.example/relay/"))
        XCTAssertEqual(
            RelayPairingInvite.defaultPairEndpoint(nodeURL: prefixed)?.absoluteString,
            "https://box.example/relay/v1/pair"
        )
        let bracketed = try XCTUnwrap(URL(string: "https://[fd00::1]:8443"))
        XCTAssertEqual(
            RelayPairingInvite.defaultPairEndpoint(nodeURL: bracketed)?.absoluteString,
            "https://[fd00::1]:8443/v1/pair"
        )
    }

    func testOnlyHTTPSchemesWithAHostAreAccepted() {
        XCTAssertNotNil(RelayPairingInvite.httpURL("http://relay.local:8443"))
        XCTAssertNil(RelayPairingInvite.httpURL("ftp://box.example"))
        XCTAssertNil(RelayPairingInvite.httpURL("file:///etc/passwd"))
        XCTAssertNil(RelayPairingInvite.httpURL("/v1/pair"))
        XCTAssertNil(RelayPairingInvite.httpURL("not a url at all"))
    }

    // MARK: - The CA pin

    func testFingerprintIsOverTheSPKIAndNotTheWholeCertificate() throws {
        let fingerprint = try XCTUnwrap(RelayPairing.spkiFingerprint(certificateDER: Self.caDER))
        XCTAssertEqual(fingerprint, Self.caFingerprint)

        // Independent of how the same key arrives: the certificate parsed from
        // PEM hashes identically.
        let fromPEM = try XCTUnwrap(RelayPairing.certificate(fromPEM: Self.caPEM))
        XCTAssertEqual(RelayPairing.spkiFingerprint(certificate: fromPEM), Self.caFingerprint)

        // Hashing the certificate itself would produce a different value, which
        // is precisely why it is not what is pinned — relayd rotates leaves.
        let wholeCertificate = Data(SHA256.hash(data: Self.caDER)).base64URLEncodedString()
        XCTAssertNotEqual(fingerprint, wholeCertificate)

        // A different key is a different pin.
        XCTAssertNotEqual(RelayPairing.spkiFingerprint(certificateDER: Self.leafDER), Self.caFingerprint)
    }

    func testFingerprintsArePastableInEveryShapeRelaydPrintsThem() {
        XCTAssertEqual(RelayPairing.normalizedFingerprint(Self.caFingerprint), Self.caFingerprint)
        XCTAssertEqual(RelayPairing.normalizedFingerprint(Self.caFingerprintBase64), Self.caFingerprint)
        XCTAssertEqual(RelayPairing.normalizedFingerprint(Self.caFingerprintHex), Self.caFingerprint)
        XCTAssertEqual(
            RelayPairing.normalizedFingerprint("  " + Self.caFingerprintHexColons + "  "),
            Self.caFingerprint
        )
        XCTAssertNil(RelayPairing.normalizedFingerprint(""))
        XCTAssertNil(RelayPairing.normalizedFingerprint("deadbeef"))
        XCTAssertNil(RelayPairing.normalizedFingerprint("not a fingerprint"))
    }

    func testGarbageDERYieldsNoFingerprintRatherThanAWrongOne() {
        XCTAssertNil(RelayPairing.spkiFingerprint(certificateDER: Data()))
        XCTAssertNil(RelayPairing.spkiFingerprint(certificateDER: Data([0x30, 0x82, 0xFF, 0xFF])))
        XCTAssertNil(RelayPairing.spkiFingerprint(certificateDER: Data(repeating: 0x41, count: 64)))
        XCTAssertNil(RelayPairing.certificate(fromPEM: "-----BEGIN CERTIFICATE-----\nnope\n"))
        XCTAssertNil(RelayPairing.certificate(fromPEM: "no pem here"))
    }

    // MARK: - Response verification

    /// Everything about the reply is checked before any field of it is used:
    /// the MAC first, then the delivered CA against the pin from the QR.
    func testResponseDecodingVerifiesTheTagBeforeAnythingElse() throws {
        let invite = try RelayPairingInvite.parse(Self.defaultLink)
        let macKey = RelayPairing.macKey(secret: invite.secret)

        let result = try RelayNodePairingClient.decodeResponse(
            Self.response(macKey: macKey), invite: invite, macKey: macKey
        )
        XCTAssertEqual(result.nodeID, "node-abc")
        XCTAssertEqual(result.nodeName, "Studio Linux")
        XCTAssertEqual(result.apiBaseURL.absoluteString, "https://192.168.1.20:8443")
        XCTAssertEqual(result.encPubkey, "ZW5jLXB1YmtleS0zMi1ieXRlcy1nb2VzLWhlcmU=")
        XCTAssertEqual(result.deviceID, "device-1")
        XCTAssertEqual(result.verificationCode, "PQRS-TUVW")
        XCTAssertEqual(result.pubkeyPEM, "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----")

        // Signed by nobody we agreed with: rejected as a tag mismatch, and the
        // node blob's fields never get looked at.
        let wrongKey = RelayPairing.macKey(secret: "attacker")
        XCTAssertThrowsError(try RelayNodePairingClient.decodeResponse(
            Self.response(macKey: wrongKey), invite: invite, macKey: macKey
        )) {
            XCTAssertEqual($0 as? RelayNodePairingError, .tagMismatch)
        }
    }

    /// A correctly-MACed reply that carries a different CA is still refused —
    /// the QR pinned one key, and only that key may end up in the keychain.
    func testACorrectlyTaggedReplyWithTheWrongCAIsRefused() throws {
        let invite = try RelayPairingInvite.parse(Self.defaultLink)
        let macKey = RelayPairing.macKey(secret: invite.secret)
        let response = Self.response(macKey: macKey, caPEM: Self.leafPEM)
        XCTAssertThrowsError(try RelayNodePairingClient.decodeResponse(
            response, invite: invite, macKey: macKey
        )) {
            XCTAssertEqual($0 as? RelayNodePairingError, .caFingerprintMismatch)
        }
    }

    func testMalformedRepliesAreRejectedWithoutCrashing() throws {
        let invite = try RelayPairingInvite.parse(Self.defaultLink)
        let macKey = RelayPairing.macKey(secret: invite.secret)
        for payload in [
            Data("not json".utf8),
            Data(#"{"blob":"!!!not base64!!!","tag":"x"}"#.utf8),
            Self.response(macKey: macKey, p12: "")
        ] {
            XCTAssertThrowsError(try RelayNodePairingClient.decodeResponse(
                payload, invite: invite, macKey: macKey
            )) {
                XCTAssertEqual($0 as? RelayNodePairingError, .malformedResponse)
            }
        }
    }

    /// The mint variant: the phone has no CSR stack, so it asks the node to
    /// mint a PKCS#12 rather than sending a public key.
    func testDeviceBlobRequestsAMintedPKCS12() throws {
        let blob = try RelayNodePairingClient.deviceBlob(deviceName: "Parikshit's iPhone")
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: blob) as? [String: String]
        )
        XCTAssertEqual(decoded["mint"], "p12")
        XCTAssertEqual(decoded["platform"], "ios")
        XCTAssertEqual(decoded["deviceName"], "Parikshit's iPhone")
        XCTAssertEqual(
            try RelayNodePairingClient.deviceBlob(deviceName: "   "),
            try RelayNodePairingClient.deviceBlob(deviceName: "iPhone")
        )
    }

    /// A tag mismatch and a CA mismatch mean somebody is in the middle; a
    /// timeout means the machine is asleep. Only the first kind is worded, and
    /// treated, as a security event.
    func testOnlyInterpositionFailuresAreFlaggedAsSecurityEvents() {
        XCTAssertTrue(RelayNodePairingError.tagMismatch.isSecurityEvent)
        XCTAssertTrue(RelayNodePairingError.caFingerprintMismatch.isSecurityEvent)
        XCTAssertTrue(RelayNodePairingError.untrustedCertificate.isSecurityEvent)
        XCTAssertFalse(RelayNodePairingError.codeRejected.isSecurityEvent)
        XCTAssertFalse(RelayNodePairingError.rateLimited.isSecurityEvent)
        XCTAssertFalse(RelayNodePairingError.unreachable("timed out").isSecurityEvent)
        XCTAssertFalse(RelayNodePairingError.server(status: 500).isSecurityEvent)
    }

    /// The code is delivered inside the MAC-authenticated node blob, so a
    /// substituted reply cannot put a code of its own on the screen — it is
    /// rejected before the blob is read at all.
    func testTheVerificationCodeIsOnlyReadFromAnAuthenticatedBlob() throws {
        let invite = try RelayPairingInvite.parse(Self.defaultLink)
        let macKey = RelayPairing.macKey(secret: invite.secret)
        XCTAssertThrowsError(try RelayNodePairingClient.decodeResponse(
            Self.response(macKey: RelayPairing.macKey(secret: "attacker"), verificationCode: "AAAA-BBBB"),
            invite: invite,
            macKey: macKey
        )) {
            XCTAssertEqual($0 as? RelayNodePairingError, .tagMismatch)
        }
    }

    /// An older relayd that does not send one is not an error: there is simply
    /// nothing to compare, and pairing is unaffected.
    func testAMissingVerificationCodeIsNotAFailure() throws {
        let invite = try RelayPairingInvite.parse(Self.defaultLink)
        let macKey = RelayPairing.macKey(secret: invite.secret)
        let result = try RelayNodePairingClient.decodeResponse(
            Self.response(macKey: macKey, verificationCode: NSNull()),
            invite: invite,
            macKey: macKey
        )
        XCTAssertNil(result.verificationCode)
        XCTAssertEqual(result.nodeID, "node-abc")
    }

    /// The node answers a mistyped confirmation code with specific advice.
    /// Relaying it verbatim beats inventing a vaguer version of it.
    func testTheMachinesOwn400ExplanationIsSurfacedVerbatim() {
        let body = Data(#"{"error":"that is the confirmation code, not the pairing token — scan the QR or paste the token"}"#.utf8)
        let detail = RelayNodePairingClient.errorMessage(in: body)
        XCTAssertEqual(detail, "that is the confirmation code, not the pairing token — scan the QR or paste the token")

        let message = RelayNodePairingError.badRequest(detail).message
        XCTAssertTrue(message.hasPrefix("That is the confirmation code"), message)
        XCTAssertTrue(message.hasSuffix("."), message)

        // No body, or an unreadable one, still says something useful.
        XCTAssertNil(RelayNodePairingClient.errorMessage(in: Data("not json".utf8)))
        XCTAssertTrue(RelayNodePairingError.badRequest(nil).message.contains("rejected the pairing request"))
    }

    /// The comparison prompt is durable, because the screen that paired does
    /// not outlive its own success — the router replaces it the moment
    /// `hasMachine` flips. Confirming clears it for good.
    @MainActor
    func testThePendingVerificationCodeSurvivesRelaunchUntilConfirmed() throws {
        let suite = "node-store-verification-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let store = RelayNodeStore(defaults: defaults)
        store.adopt(RelayPairedNode(
            nodeID: "node-abc",
            nodeName: "Studio Linux",
            apiBaseURL: try XCTUnwrap(URL(string: "https://192.168.1.20:8443")),
            deviceID: "device-1",
            pendingVerificationCode: "PQRS-TUVW"
        ))

        let relaunched = RelayNodeStore(defaults: defaults)
        XCTAssertEqual(relaunched.pendingVerificationCode, "PQRS-TUVW")
        XCTAssertEqual(relaunched.pairedNode?.deviceID, "device-1")
        // Pairing is already complete: the machine is usable while the
        // comparison is outstanding. This is a check, not a gate.
        XCTAssertTrue(relaunched.hasMachine)

        relaunched.confirmVerification()
        XCTAssertNil(relaunched.pendingVerificationCode)
        XCTAssertNil(RelayNodeStore(defaults: defaults).pendingVerificationCode)
        XCTAssertTrue(RelayNodeStore(defaults: defaults).hasMachine)

        // Idempotent: a second confirmation cannot resurrect or re-prompt.
        relaunched.confirmVerification()
        XCTAssertNil(relaunched.pendingVerificationCode)
    }

    // MARK: - The store the pairing writes into

    @MainActor
    func testPairedNodePersistsAcrossLaunchesAndClearsOnUnpair() throws {
        let suite = "node-store-pairing-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let store = RelayNodeStore(defaults: defaults)
        XCTAssertNil(store.pairedNode)
        XCTAssertNil(store.activeNodeURL)

        let node = RelayPairedNode(
            nodeID: "node-abc",
            nodeName: "Studio Linux",
            apiBaseURL: try XCTUnwrap(URL(string: "https://192.168.1.20:8443")),
            pubkeyPEM: "pem",
            encPubkey: "enc"
        )
        store.adopt(node)
        XCTAssertEqual(store.effectiveBaseURL.absoluteString, "https://192.168.1.20:8443")
        XCTAssertTrue(store.hasMachine)
        XCTAssertEqual(store.pairedNode?.host, "192.168.1.20")

        let restored = RelayNodeStore(defaults: defaults)
        XCTAssertEqual(restored.pairedNode, node)
        XCTAssertNil(restored.pairedNode?.registeredAccountID)

        restored.markRegistered(accountID: "account-1")
        XCTAssertEqual(RelayNodeStore(defaults: defaults).pairedNode?.registeredAccountID, "account-1")

        restored.clear()
        XCTAssertNil(RelayNodeStore(defaults: defaults).pairedNode)
    }

    /// The trial pointer this store used to keep is not migrated, it is
    /// removed: those machines no longer exist, and a dead pointer is a host
    /// the app would otherwise dial.
    @MainActor
    func testTheOldTrialPointerIsDiscardedOnFirstLaunch() throws {
        let suite = "node-store-legacy-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defaults.set(Data("{\"id\":\"t1\"}".utf8), forKey: "com.parikshit.pocvault.trial.node")

        let store = RelayNodeStore(defaults: defaults)
        XCTAssertNil(store.pairedNode)
        XCTAssertNil(defaults.data(forKey: "com.parikshit.pocvault.trial.node"))
    }

    @MainActor
    private func makeModel() throws -> NodePairingModel {
        let suite = "node-pairing-model-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        let identityStore = ClientIdentityStore(defaults: defaults)
        let authClient = RelayAuthClient(baseURL: try XCTUnwrap(URL(string: "https://cloud.test")))
        return NodePairingModel(
            identityStore: identityStore,
            nodeStore: RelayNodeStore(defaults: defaults),
            accountStore: RelayAccountStore(
                client: authClient,
                identityStore: identityStore,
                defaults: defaults
            ),
            authClient: authClient,
            deviceName: "Test iPhone"
        )
    }

    // MARK: - Fixtures

    private static func response(
        macKey: SymmetricKey,
        caPEM: String? = nil,
        p12: String? = nil,
        verificationCode: Any = "PQRS-TUVW"
    ) -> Data {
        let blob = try! JSONSerialization.data(withJSONObject: [
            "deviceId": "device-1",
            "p12": p12 ?? Data("pretend-pkcs12".utf8).base64EncodedString(),
            "caPem": caPEM ?? Self.caPEM,
            "nodeId": "node-abc",
            "nodeName": "Studio Linux",
            "certSerial": "01",
            "notAfter": "2027-01-01T00:00:00Z",
            "apiBaseUrl": "https://192.168.1.20:8443",
            "pubkey": "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----",
            "encPubkey": "ZW5jLXB1YmtleS0zMi1ieXRlcy1nb2VzLWhlcmU=",
            "verificationCode": verificationCode
        ], options: [.sortedKeys])
        let tag = RelayPairing.blobTag(macKey: macKey, slot: RelayPairing.nodeSlot, blob: blob)
        return try! JSONSerialization.data(withJSONObject: [
            "v": 2,
            "blob": blob.base64EncodedString(),
            "tag": tag
        ])
    }

    private static func makeLink(
        version: String = "1",
        api: String = "https://192.168.1.20:8443",
        pair: String = "https://192.168.1.20:8443/v1/pair",
        fingerprint: String? = nil,
        dropping: String? = nil
    ) -> String {
        var fields: [(String, String)] = [
            ("v", version),
            ("n", "node-abc"),
            ("m", "Studio Linux"),
            ("t", "tok3n-value"),
            ("p", Data(pair.utf8).base64URLEncodedString()),
            ("a", Data(api.utf8).base64URLEncodedString()),
            ("f", fingerprint ?? caFingerprint)
        ]
        if let dropping {
            fields.removeAll { $0.0 == dropping }
        }
        let fragment = fields.map { "\($0.0)=\($0.1)" }.joined(separator: "&")
        return "https://get.openrelay.sh/pair#" + fragment
    }

    private static let defaultLink = makeLink()

    /// `sha256` over `caDER`'s SubjectPublicKeyInfo, computed with openssl
    /// (`openssl x509 -pubkey | openssl pkey -pubin -outform der | sha256`), so
    /// this pins the Swift implementation against an independent one.
    static let caFingerprint = "OqxiKsjvv7Iz4moH9WKEpUfnTBAyD406gOa9SWa2ufA"
    static let caFingerprintBase64 = "OqxiKsjvv7Iz4moH9WKEpUfnTBAyD406gOa9SWa2ufA="
    static let caFingerprintHex = "3aac622ac8efbfb233e26a07f56284a547e74c10320f8d3a80e6bd4966b6b9f0"
    static let caFingerprintHexColons =
        "3a:ac:62:2a:c8:ef:bf:b2:33:e2:6a:07:f5:62:84:a5:47:e7:4c:10:32:0f:8d:3a:80:e6:bd:49:66:b6:b9:f0"

    /// Throwaway certificates generated for tests only — public DER, no keys.
    /// `ca` is self-signed; `leaf` (CN=iphone) is issued by it, mirroring the
    /// shape of the PKCS#12 relayd builds with `-certfile <ca.pem>`.
    static let caDER = Data(base64Encoded:
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

    static let leafDER = Data(base64Encoded:
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

    static let caPEM = pem(caDER)
    static let leafPEM = pem(leafDER)

    private static func pem(_ der: Data) -> String {
        let body = der.base64EncodedString()
        let lines = stride(from: 0, to: body.count, by: 64).map { offset -> String in
            let start = body.index(body.startIndex, offsetBy: offset)
            let end = body.index(start, offsetBy: min(64, body.count - offset))
            return String(body[start..<end])
        }
        return (["-----BEGIN CERTIFICATE-----"] + lines + ["-----END CERTIFICATE-----"])
            .joined(separator: "\n")
    }
}
