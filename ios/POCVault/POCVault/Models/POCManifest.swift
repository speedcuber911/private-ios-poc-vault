import Foundation

struct POCManifest: Codable, Equatable {
    let schemaVersion: Int
    let generatedAt: Date?
    let pocs: [POCEntry]

    var version: Int { schemaVersion }
    var entries: [POCEntry] { pocs }

    static func decode(from data: Data) throws -> POCManifest {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)

            if let date = ISO8601DateFormatter.pocVaultFractional.date(from: value) {
                return date
            }
            if let date = ISO8601DateFormatter.pocVaultStandard.date(from: value) {
                return date
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Expected an ISO-8601 date, got \(value)."
            )
        }
        let manifest = try decoder.decode(POCManifest.self, from: data)
        guard manifest.schemaVersion == 1 else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(
                    codingPath: [],
                    debugDescription: "Unsupported manifest schemaVersion \(manifest.schemaVersion)."
                )
            )
        }
        return manifest
    }

    var entriesByRecentUpdate: [POCEntry] {
        entries.sorted {
            ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast)
        }
    }
}

private extension ISO8601DateFormatter {
    static let pocVaultStandard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static let pocVaultFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}
