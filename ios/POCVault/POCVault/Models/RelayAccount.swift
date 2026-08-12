import Foundation

struct RelayAccountUser: Codable, Equatable, Identifiable {
    let id: String
    let name: String
    let email: String
    let username: String?
    let displayUsername: String?
    let image: String?

    var preferredName: String {
        let candidates = [displayUsername, name, username, email]
        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "Relay user"
    }

    var usesPassword: Bool {
        username?.isEmpty == false
    }
}

struct RelayAuthResult: Decodable {
    let token: String?
    let user: RelayAccountUser
}

struct RelaySessionResult: Decodable {
    let user: RelayAccountUser
}

struct RelayDeleteAccountResult: Decodable, Equatable {
    let success: Bool
    let message: String
}
