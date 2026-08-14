import Foundation

struct RelayTrialNode: Codable, Equatable {
    enum State: String, Codable { case creating, ready, expired, destroyed, failed, upgraded }
    let id: String
    let state: State
    let nodeId: String?
    let sni: String?
    let createdAt: Int64   // epoch ms
    let expiresAt: Int64   // epoch ms
    var nodeURL: URL? { sni.flatMap { URL(string: "https://\($0)") } }
    var expiresDate: Date { Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000) }

    /// User-facing countdown copy for the trial badge/banner: "N days left"
    /// while more than a day remains, "N hours left" under a day, and "Trial
    /// expired" once the clock (or the server-reported state) says so.
    func remainingDescription(now: Date = Date()) -> String {
        switch state {
        case .expired, .destroyed, .failed:
            return "Trial expired"
        case .upgraded:
            return ""
        case .creating, .ready:
            break
        }
        let remaining = expiresDate.timeIntervalSince(now)
        guard remaining > 0 else { return "Trial expired" }
        let days = Int(remaining / 86_400)
        if days >= 1 {
            return "\(days) day\(days == 1 ? "" : "s") left"
        }
        let hours = max(1, Int((remaining / 3_600).rounded(.up)))
        return "\(hours) hour\(hours == 1 ? "" : "s") left"
    }

    /// Root-browser trial chrome: countdown capsule or expiry banner.
    /// Hidden once the machine is no longer a trial (`upgraded`) or never
    /// became a usable trial (`destroyed` / `failed`).
    var showsStatusBanner: Bool {
        switch state {
        case .creating, .ready, .expired:
            return true
        case .upgraded, .destroyed, .failed:
            return false
        }
    }

    /// Account → Trial machine (status + delete). Hidden after upgrade so
    /// the gifted machine is not presented as a deletable trial.
    var showsTrialMachineSection: Bool {
        state != .upgraded
    }
}
