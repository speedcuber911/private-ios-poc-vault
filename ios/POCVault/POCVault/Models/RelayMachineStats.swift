import Foundation

/// Host usage snapshot from `GET /v1/machine/stats`.
///
/// The numbers stay on the paired machine. The control plane is told only
/// that pressure or reachability changed, never the percentages.
struct RelayMachineStats: Decodable, Equatable {
    struct Host: Decodable, Equatable {
        let hostname: String?
        let platform: String?
        let arch: String?
        let uptimeSec: Int?
    }

    struct CPU: Decodable, Equatable {
        let usedPercent: Double?
        let count: Int?
        let load1: Double?
        let load5: Double?
        let load15: Double?
    }

    struct Memory: Decodable, Equatable {
        let usedPercent: Double?
        let usedBytes: Int64?
        let totalBytes: Int64?
        let availableBytes: Int64?
    }

    struct Disk: Decodable, Equatable {
        let usedPercent: Double?
        let usedBytes: Int64?
        let totalBytes: Int64?
        let freeBytes: Int64?
        let path: String?
    }

    struct Jobs: Decodable, Equatable {
        let active: Int
        let queued: Int
    }

    struct Network: Decodable, Equatable {
        let rxBytesPerSec: Double?
        let txBytesPerSec: Double?
    }

    struct IO: Decodable, Equatable {
        let readBytesPerSec: Double?
        let writeBytesPerSec: Double?
        let readOpsPerSec: Double?
        let writeOpsPerSec: Double?
    }

    struct Alert: Decodable, Equatable, Identifiable {
        let kind: Kind
        let state: State

        var id: Kind { kind }

        enum Kind: String, Decodable {
            case cpu
            case memory
            case disk
            case unknown

            init(from decoder: Decoder) throws {
                let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
                self = Kind(rawValue: raw) ?? .unknown
            }
        }

        enum State: String, Decodable {
            case ok
            case firing
            case unknown

            init(from decoder: Decoder) throws {
                let raw = (try? decoder.singleValueContainer().decode(String.self)) ?? ""
                self = State(rawValue: raw) ?? .unknown
            }
        }

        var title: String {
            switch kind {
            case .cpu: return "CPU"
            case .memory: return "Memory"
            case .disk: return "Disk"
            case .unknown: return "Usage"
            }
        }

        var firingCopy: String {
            switch kind {
            case .cpu: return "CPU has been high"
            case .memory: return "Memory has been high"
            case .disk: return "Disk is almost full"
            case .unknown: return "This machine is under load"
            }
        }
    }

    struct Sample: Decodable, Equatable {
        let ts: String?
        let cpuPercent: Double?
        let memoryUsedPercent: Double?
        let diskUsedPercent: Double?
        let netRxBytesPerSec: Double?
        let netTxBytesPerSec: Double?
        let diskReadBytesPerSec: Double?
        let diskWriteBytesPerSec: Double?
    }

    let ok: Bool
    let sampledAt: String?
    let host: Host
    let cpu: CPU
    let memory: Memory
    let disk: Disk
    let jobs: Jobs
    let network: Network?
    let io: IO?
    let alerts: [Alert]
    let history: [Sample]

    var firingAlerts: [Alert] {
        alerts.filter { $0.state == .firing }
    }

    var summaryLine: String {
        let parts = [
            cpu.usedPercent.map { "CPU \(Self.percentText($0))" },
            memory.usedPercent.map { "Mem \(Self.percentText($0))" },
            disk.usedPercent.map { "Disk \(Self.percentText($0))" }
        ].compactMap { $0 }
        return parts.isEmpty ? "Usage" : parts.joined(separator: " · ")
    }

    var lastUpdatedText: String? {
        guard let date = Self.parseDate(sampledAt) else { return nil }
        return date.formatted(Date.FormatStyle().hour().minute().second())
    }

    var historyWindowLabel: String {
        guard
            let first = history.compactMap({ Self.parseDate($0.ts) }).first,
            let last = history.compactMap({ Self.parseDate($0.ts) }).last
        else { return "Recent" }
        let minutes = Int(last.timeIntervalSince(first) / 60)
        if minutes >= 50 { return "Last hour" }
        if minutes >= 2 { return "Last \(minutes) min" }
        return "Recent"
    }

    var showsNetwork: Bool {
        network?.rxBytesPerSec != nil
            || network?.txBytesPerSec != nil
            || history.contains { $0.netRxBytesPerSec != nil || $0.netTxBytesPerSec != nil }
    }

    var showsDiskIO: Bool {
        io?.readBytesPerSec != nil
            || io?.writeBytesPerSec != nil
            || history.contains { $0.diskReadBytesPerSec != nil || $0.diskWriteBytesPerSec != nil }
    }

    /// Applies an incremental SSE sample without making the daemon resend or
    /// the phone re-decode the complete chart history every five seconds.
    func mergingLiveSample(_ next: RelayMachineStats, historyLimit: Int = 720) -> RelayMachineStats {
        var mergedHistory = history
        for sample in next.history {
            if let timestamp = sample.ts,
               let lastIndex = mergedHistory.indices.last,
               mergedHistory[lastIndex].ts == timestamp {
                mergedHistory[lastIndex] = sample
            } else {
                mergedHistory.append(sample)
            }
        }
        if mergedHistory.count > historyLimit {
            mergedHistory.removeFirst(mergedHistory.count - historyLimit)
        }

        return RelayMachineStats(
            ok: next.ok,
            sampledAt: next.sampledAt,
            host: next.host,
            cpu: next.cpu,
            memory: next.memory,
            disk: next.disk,
            jobs: next.jobs,
            network: next.network,
            io: next.io,
            alerts: next.alerts,
            history: mergedHistory
        )
    }

    static func parseDate(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if let date = try? Date(value, strategy: .iso8601) { return date }
        if let date = fractionalISO.date(from: value) { return date }
        if let date = plainISO.date(from: value) { return date }
        return fallbackISO.date(from: value)
    }

    static func percentText(_ value: Double) -> String {
        String(format: "%.0f%%", value)
    }

    static func rateText(_ bytesPerSec: Double?) -> String {
        guard let bytesPerSec, bytesPerSec >= 0, bytesPerSec.isFinite else { return "—" }
        if bytesPerSec < 1024 { return String(format: "%.0f B/s", bytesPerSec) }
        if bytesPerSec < 1_048_576 { return String(format: "%.1f KB/s", bytesPerSec / 1024) }
        return String(format: "%.1f MB/s", bytesPerSec / 1_048_576)
    }

    private static let fractionalISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private static let plainISO: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter
    }()

    private static let fallbackISO: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
        return formatter
    }()

    static func bytesText(_ value: Int64?) -> String? {
        guard let value else { return nil }
        return ByteCountFormatter.string(fromByteCount: value, countStyle: .file)
    }

    static func uptimeText(_ seconds: Int?) -> String? {
        guard let seconds, seconds >= 0 else { return nil }
        let days = seconds / 86_400
        let hours = (seconds % 86_400) / 3_600
        if days > 0 { return "\(days)d \(hours)h" }
        let minutes = (seconds % 3_600) / 60
        if hours > 0 { return "\(hours)h \(minutes)m" }
        return "\(minutes)m"
    }
}
