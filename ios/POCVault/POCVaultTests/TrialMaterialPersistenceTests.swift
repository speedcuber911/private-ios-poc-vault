import XCTest
@testable import POCVault

/// Trial credential bookkeeping must outlive the app container.
///
/// The PKCS#12 identity lives in the keychain and survives an app reinstall —
/// `preferredClientCertificateNames` carries "trial-device" specifically so it
/// can be found again. The facts ABOUT it used to live in `UserDefaults`, which
/// iOS deletes with the app. After a TestFlight reinstall the identity was
/// still on the device and every predicate describing it read false, so
/// `RelayTrialFlowModel.adoptExistingTrial` told the user their credential
/// "can't be reissued" while it sat in the keychain — and the device bearer
/// token, derived from a pairing secret that only exists during pairing, really
/// was gone for good. The account's one trial was spent and its machine
/// unreachable.
///
/// These tests model a reinstall the way iOS does it: a brand-new `UserDefaults`
/// suite (the container is gone) against the same keychain (which is not).
final class TrialMaterialPersistenceTests: XCTestCase {

    private let host = "abc123.tun.example.test"

    override func setUp() {
        super.setUp()
        ClientIdentityStore(defaults: freshDefaults("setup")).forgetTrialMaterialForTesting()
    }

    override func tearDown() {
        ClientIdentityStore(defaults: freshDefaults("teardown")).forgetTrialMaterialForTesting()
        super.tearDown()
    }

    private func freshDefaults(_ name: String) -> UserDefaults {
        let suite = "trial-material-\(name)-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    // The regression, stated directly.
    func testTrialMaterialSurvivesAnAppReinstall() throws {
        let before = ClientIdentityStore(defaults: freshDefaults("install-1"))
        before.pinTrialMaterial(caCertificate: nil, host: host)
        before.storeDeviceToken("device-token-abc", host: host)

        XCTAssertTrue(before.hasTrialIssuedIdentity)
        XCTAssertEqual(before.deviceToken(for: host), "device-token-abc")

        // Reinstall: the container — and therefore UserDefaults — is gone.
        let after = ClientIdentityStore(defaults: freshDefaults("install-2"))

        XCTAssertTrue(
            after.hasTrialIssuedIdentity,
            "the identity survives a reinstall in the keychain, so the marker describing it must too"
        )
        XCTAssertEqual(
            after.deviceToken(for: host), "device-token-abc",
            "the device token is derived from a pairing secret that no longer exists — losing it strands the user"
        )
        XCTAssertEqual(after.pinnedHost, host)
    }

    // An install that predates the keychain move still has its material in
    // UserDefaults. It must be promoted, not abandoned — that population is the
    // one still able to be saved.
    func testLegacyUserDefaultsMaterialIsMigratedIntoTheKeychain() throws {
        let defaults = freshDefaults("legacy")
        defaults.set(true, forKey: "com.parikshit.pocvault.identity.trialIssued")
        defaults.set(host, forKey: "com.parikshit.pocvault.identity.pinnedHost")
        defaults.set("legacy-token", forKey: "com.parikshit.pocvault.identity.deviceToken")
        defaults.set(host, forKey: "com.parikshit.pocvault.identity.deviceTokenHost")

        let store = ClientIdentityStore(defaults: defaults)
        XCTAssertTrue(store.hasTrialIssuedIdentity)
        XCTAssertEqual(store.deviceToken(for: host), "legacy-token")

        // Promoted, and the old copy removed so there is one source of truth.
        XCTAssertNil(defaults.string(forKey: "com.parikshit.pocvault.identity.deviceToken"))
        XCTAssertFalse(defaults.bool(forKey: "com.parikshit.pocvault.identity.trialIssued"))

        // And it now survives the reinstall that would previously have lost it.
        let reinstalled = ClientIdentityStore(defaults: freshDefaults("legacy-2"))
        XCTAssertEqual(reinstalled.deviceToken(for: host), "legacy-token")
    }

    // Sign-out has to be explicit now: uninstalling no longer takes the material
    // with it, so a purge that missed would hand the next account on this phone
    // a working credential for someone else's machine.
    func testSignOutPurgeRemovesMaterialThatNowOutlivesTheContainer() throws {
        let store = ClientIdentityStore(defaults: freshDefaults("purge"))
        store.pinTrialMaterial(caCertificate: nil, host: host)
        store.storeDeviceToken("secret-token", host: host)
        XCTAssertTrue(store.hasTrialIssuedIdentity)

        store.discardTrialMaterial()

        XCTAssertFalse(store.hasTrialIssuedIdentity)
        XCTAssertNil(store.deviceToken(for: host))
        XCTAssertNil(store.pinnedHost)

        let next = ClientIdentityStore(defaults: freshDefaults("purge-2"))
        XCTAssertNil(
            next.deviceToken(for: host),
            "a purge must reach the keychain, or the next account inherits machine access"
        )
        XCTAssertFalse(next.hasTrialIssuedIdentity)
    }

    // The host scoping is what stops a token from one machine being offered to
    // another. Moving stores must not have loosened it.
    func testTheDeviceTokenIsStillScopedToItsHost() throws {
        let store = ClientIdentityStore(defaults: freshDefaults("scope"))
        store.storeDeviceToken("token-for-a", host: host)

        XCTAssertEqual(store.deviceToken(for: host), "token-for-a")
        XCTAssertEqual(store.deviceToken(for: host.uppercased()), "token-for-a", "host match is case-insensitive")
        XCTAssertNil(store.deviceToken(for: "other.tun.example.test"))
        XCTAssertNil(store.deviceToken(for: ""))
    }

    // A BYO import passes host: nil and must never begin pinning or claim to be
    // trial-issued.
    func testABYOImportStartsNoPinning() throws {
        let store = ClientIdentityStore(defaults: freshDefaults("byo"))
        store.pinTrialMaterial(caCertificate: nil, host: nil)
        store.pinTrialMaterial(caCertificate: nil, host: "   ")

        XCTAssertFalse(store.hasTrialIssuedIdentity)
        XCTAssertNil(store.pinnedHost)
    }
}
