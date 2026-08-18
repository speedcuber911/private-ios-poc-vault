import XCTest
@testable import POCVault

final class AccountTests: XCTestCase {
    func testStoreKitAppAccountTokenMatchesServerDerivation() {
        XCTAssertEqual(
            RelaySubscriptionStore.appAccountToken(accountID: "account-a").uuidString.lowercased(),
            "332798da-332f-436e-a13a-c1d2f176bb7e"
        )
    }

    func testRelayAccountPrefersDisplayUsernameAndDetectsPasswordAccounts() {
        let user = RelayAccountUser(
            id: "user-1",
            name: "Relay User",
            email: "relay@example.com",
            username: "relay_user",
            displayUsername: "Relay User",
            image: nil
        )

        XCTAssertEqual(user.preferredName, "Relay User")
        XCTAssertTrue(user.usesPassword)
    }

    func testAppleAccountDoesNotRequireDeletionPassword() {
        let user = RelayAccountUser(
            id: "user-2",
            name: "Apple User",
            email: "private@privaterelay.appleid.com",
            username: nil,
            displayUsername: nil,
            image: nil
        )

        XCTAssertFalse(user.usesPassword)
    }

    func testBetterAuthErrorsAreConvertedToUsefulMessages() throws {
        let data = try XCTUnwrap(
            #"{"message":"Invalid username or password","code":"INVALID_USERNAME_OR_PASSWORD"}"#
                .data(using: .utf8)
        )

        let error = RelayAuthClientError.decode(status: 401, data: data)

        XCTAssertEqual(error.localizedDescription, "The username or password is incorrect.")
    }

    func testAppleLinkConflictExplainsTheOtherAccount() throws {
        let data = try XCTUnwrap(
            #"{"message":"account not linked","code":"OAUTH_LINK_ERROR"}"#
                .data(using: .utf8)
        )
        let error = RelayAuthClientError.decode(status: 401, data: data)
        XCTAssertEqual(
            error.localizedDescription,
            "This Apple ID is already used on a different Relay account. Sign in with your username and password, or use the Apple ID that created that account."
        )
    }
}
