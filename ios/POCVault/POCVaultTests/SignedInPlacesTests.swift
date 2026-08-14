import XCTest
@testable import POCVault

final class SignedInPlacesTests: XCTestCase {
    func testPlacesPayloadDecodesComputerAndBrowsers() throws {
        let data = Data(#"""
        {
          "computer": {
            "id": "c1",
            "machineName": "dev-box",
            "platform": "macos",
            "status": "connected",
            "connectedAt": 1,
            "createdAt": 1
          },
          "browsers": [
            { "id": "b1", "name": "Safari on Mac", "platform": "web", "createdAt": 2 }
          ]
        }
        """#.utf8)
        let places = try JSONDecoder().decode(RelaySignedInPlaces.self, from: data)
        XCTAssertEqual(places.computer?.id, "c1")
        XCTAssertEqual(places.browsers.count, 1)
        XCTAssertEqual(places.browsers[0].id, "b1")
        XCTAssertEqual(places.browsers[0].name, "Safari on Mac")
    }

    func testPlacesPayloadAllowsNullComputer() throws {
        let data = Data(#"""
        { "computer": null, "browsers": [] }
        """#.utf8)
        let places = try JSONDecoder().decode(RelaySignedInPlaces.self, from: data)
        XCTAssertNil(places.computer)
        XCTAssertTrue(places.browsers.isEmpty)
    }
}
