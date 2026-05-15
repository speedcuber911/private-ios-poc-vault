import Foundation

struct POCEntry: Codable, Hashable, Identifiable {
    let id: String
    let title: String
    let summary: String?
    let url: URL
    let updatedAt: Date?
    let tags: [String]
    let requiresClientCertificate: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case slug
        case title
        case summary
        case description
        case url
        case updatedAt
        case tags
        case requiresClientCertificate
    }

    init(
        id: String,
        title: String,
        summary: String?,
        url: URL,
        updatedAt: Date?,
        tags: [String],
        requiresClientCertificate: Bool
    ) {
        self.id = id
        self.title = title
        self.summary = summary
        self.url = url
        self.updatedAt = updatedAt
        self.tags = tags
        self.requiresClientCertificate = requiresClientCertificate
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id)
            ?? container.decode(String.self, forKey: .slug)
        title = try container.decode(String.self, forKey: .title)
        summary = try container.decodeIfPresent(String.self, forKey: .summary)
            ?? container.decodeIfPresent(String.self, forKey: .description)
        url = try container.decode(URL.self, forKey: .url)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
        tags = try container.decodeIfPresent([String].self, forKey: .tags) ?? []
        requiresClientCertificate = try container.decodeIfPresent(Bool.self, forKey: .requiresClientCertificate) ?? true
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(title, forKey: .title)
        try container.encodeIfPresent(summary, forKey: .summary)
        try container.encode(url, forKey: .url)
        try container.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try container.encode(tags, forKey: .tags)
        try container.encode(requiresClientCertificate, forKey: .requiresClientCertificate)
    }

    var displayHost: String {
        url.host(percentEncoded: false) ?? url.host ?? url.absoluteString
    }

    var detailText: String {
        if let summary, !summary.isEmpty {
            return summary
        }
        return displayHost
    }

    func matchesSearch(_ query: String) -> Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return true }

        let haystack = ([title, summary ?? "", displayHost] + tags)
            .joined(separator: " ")
            .localizedLowercase
        return haystack.contains(trimmed.localizedLowercase)
    }
}
