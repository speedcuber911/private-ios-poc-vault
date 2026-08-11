import Foundation

struct RelayTrialNode: Codable, Equatable {
    enum State: String, Codable { case creating, ready, expired, destroyed, failed }
    let id: String
    let state: State
    let nodeId: String?
    let sni: String?
    let createdAt: Int64   // epoch ms
    let expiresAt: Int64   // epoch ms
    var nodeURL: URL? { sni.flatMap { URL(string: "https://\($0)") } }
    var expiresDate: Date { Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000) }
}
