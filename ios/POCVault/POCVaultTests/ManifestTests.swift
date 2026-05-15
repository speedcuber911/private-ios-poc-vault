import CryptoKit
import XCTest
@testable import POCVault

final class ManifestTests: XCTestCase {
    func testDecodesManifestEntriesWithISO8601Dates() throws {
        let json = """
        {
          "schemaVersion": 1,
          "generatedAt": "2026-05-15T10:00:00Z",
          "pocs": [
            {
              "slug": "smoke",
              "title": "Smoke Test",
              "description": "Small internal POC",
              "url": "https://smoke.pocs.example.com/",
              "updatedAt": "2026-05-14T09:30:00Z",
              "tags": ["demo", "ios"]
            }
          ]
        }
        """.data(using: .utf8)!

        let manifest = try POCManifest.decode(from: json)

        XCTAssertEqual(manifest.version, 1)
        XCTAssertEqual(manifest.entries.first?.id, "smoke")
        XCTAssertEqual(manifest.entries.first?.displayHost, "smoke.pocs.example.com")
        XCTAssertEqual(manifest.entries.first?.requiresClientCertificate, true)
    }

    func testSearchMatchesTitleSummaryAndTags() throws {
        let entry = POCEntry(
            id: "alpha",
            title: "Forecast Console",
            summary: "Demand planner prototype",
            url: URL(string: "https://poc-vault.test/forecast")!,
            updatedAt: nil,
            tags: ["sales"],
            requiresClientCertificate: false
        )

        XCTAssertTrue(entry.matchesSearch("forecast"))
        XCTAssertTrue(entry.matchesSearch("planner"))
        XCTAssertTrue(entry.matchesSearch("sales"))
        XCTAssertFalse(entry.matchesSearch("finance"))
    }

    func testEd25519SignatureVerificationUsesRawPublicKeyBytes() throws {
        let privateKey = Curve25519.Signing.PrivateKey()
        let payload = Data("manifest".utf8)
        let signature = try privateKey.signature(for: payload)

        XCTAssertTrue(
            ManifestClient.verifySignature(
                payload: payload,
                signature: signature,
                publicKeyRawRepresentation: privateKey.publicKey.rawRepresentation
            )
        )
        XCTAssertFalse(
            ManifestClient.verifySignature(
                payload: Data("tampered".utf8),
                signature: signature,
                publicKeyRawRepresentation: privateKey.publicKey.rawRepresentation
            )
        )
    }
}
