import Charts
import SwiftUI

@MainActor
final class RelayMachineMonitorModel: ObservableObject {
    @Published var stats: RelayMachineStats?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var unsupported = false

    /// Runs inside SwiftUI's visibility- and scene-bound `.task`. There is no
    /// model-owned background task: leaving Usage or backgrounding the app
    /// cancels the consumer, which closes the daemon's SSE connection.
    func monitor(client: CodexClient) async {
        if stats == nil { isLoading = true }
        defer { isLoading = false }

        var retryDelay = 1.0
        while !Task.isCancelled {
            do {
                for try await event in client.streamMachineStats() {
                    guard !Task.isCancelled else { return }
                    apply(event)
                    retryDelay = 1
                }
                guard !Task.isCancelled else { return }
            } catch let error as CodexClientError where error.isGenericRouteNotFound {
                // One-release compatibility for a linked machine that has the
                // snapshot route but predates its SSE companion.
                await pollLegacySnapshot(client: client)
                return
            } catch {
                guard !Task.isCancelled else { return }
                errorMessage = "Relay couldn't reach your machine. Reconnecting…"
            }

            do {
                try await Task.sleep(for: .seconds(retryDelay))
            } catch {
                return
            }
            retryDelay = min(retryDelay * 2, 10)
        }
    }

    func refresh(client: CodexClient) async {
        if stats == nil { isLoading = true }
        defer { isLoading = false }
        do {
            if let next = try await client.fetchMachineStats() {
                stats = next
                errorMessage = nil
                unsupported = false
            } else {
                unsupported = true
                errorMessage = nil
            }
        } catch {
            errorMessage = "Relay couldn't reach your machine."
        }
    }

    private func apply(_ event: RelayMachineStatsStreamEvent) {
        switch event {
        case .snapshot(let next):
            stats = next
        case .sample(let next):
            stats = stats?.mergingLiveSample(next) ?? next
        }
        isLoading = false
        errorMessage = nil
        unsupported = false
    }

    private func pollLegacySnapshot(client: CodexClient) async {
        while !Task.isCancelled {
            await refresh(client: client)
            do {
                try await Task.sleep(for: .seconds(5))
            } catch {
                return
            }
        }
    }
}

private struct RelayUsagePoint: Identifiable {
    let id: String
    let date: Date
    let value: Double
    let series: String
}

struct RelayMachineMonitorView: View {
    let client: CodexClient
    var identityStore: ClientIdentityStore? = nil
    let machineName: String
    var showsDismissButton = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = RelayMachineMonitorModel()
    @StateObject private var powerModel = RelayMachinePowerModel()
    @State private var showingStopPower = false

    var body: some View {
        Group {
            if let stats = model.stats {
                usageScroll(stats)
            } else if model.unsupported {
                statusPage(
                    status: "Unavailable",
                    warn: false,
                    info: Self.unsupportedInfo
                )
            } else if let errorMessage = model.errorMessage {
                VStack(alignment: .leading, spacing: 20) {
                    statusHeader(
                        status: unreachableStatusLabel,
                        warn: !isPowerStatePending,
                        info: canControlPower ? Self.powerInfo : Self.usageInfo
                    )
                    if isPowerStatePending {
                        Text("Checking whether this machine is powered on…")
                            .font(AppTheme.uiFont(size: 16))
                            .foregroundStyle(AppTheme.textSecondary)
                    } else if powerModel.status != .off {
                        Text(errorMessage)
                            .font(AppTheme.uiFont(size: 16))
                            .foregroundStyle(AppTheme.statusError)
                    } else {
                        Text("This machine is stopped. Turn Power on from here. No Relay account needed.")
                            .font(AppTheme.uiFont(size: 16))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    if canControlPower {
                        Button("Try again") {
                            Task { await model.refresh(client: client) }
                        }
                        .buttonStyle(RelayOutlineButtonStyle())
                    } else {
                        Button("Try again") {
                            Task { await model.refresh(client: client) }
                        }
                        .buttonStyle(RelayPrimaryButtonStyle())
                    }
                    if let notice = powerModel.notice {
                        Text(notice)
                            .font(AppTheme.uiFont(size: 15))
                            .foregroundStyle(AppTheme.statusError)
                    }
                }
                .padding(22)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    statusHeader(status: "Reading", warn: false, info: Self.usageInfo)
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Reading this machine…")
                            .font(AppTheme.uiFont(size: 15))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
                .padding(22)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .background(AppTheme.bgCanvas.ignoresSafeArea())
        .tint(AppTheme.accent)
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsDismissButton {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .refreshable {
            await model.refresh(client: client)
            await powerModel.refresh()
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            if let identityStore {
                powerModel.configure(identityStore: identityStore)
                await powerModel.refresh()
            }
            await model.monitor(client: client)
        }
        .confirmationDialog(
            "Stop \(machineName)?",
            isPresented: $showingStopPower,
            titleVisibility: .visible
        ) {
            Button("Stop machine", role: .destructive) {
                Task { await powerModel.stop() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Runs stop. Pairing stays on disk. Start it again from this phone when you need it.")
        }
        .preferredColorScheme(.dark)
    }

    private func usageScroll(_ stats: RelayMachineStats) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                header(stats)
                if !stats.firingAlerts.isEmpty {
                    attention(stats)
                }
                percentChart(
                    title: "CPU",
                    value: stats.cpu.usedPercent,
                    detail: [stats.cpu.count.map { "\($0) cores" }, stats.historyWindowLabel]
                        .compactMap { $0 }
                        .joined(separator: " · "),
                    points: percentPoints(stats, \.cpuPercent, current: stats.cpu.usedPercent),
                    firing: isFiring(stats, .cpu)
                )
                percentChart(
                    title: "Memory",
                    value: stats.memory.usedPercent,
                    detail: [
                        RelayMachineStats.bytesText(stats.memory.availableBytes).map { "\($0) free" },
                        stats.historyWindowLabel
                    ]
                    .compactMap { $0 }
                    .joined(separator: " · "),
                    points: percentPoints(stats, \.memoryUsedPercent, current: stats.memory.usedPercent),
                    firing: isFiring(stats, .memory)
                )
                percentChart(
                    title: "Disk",
                    value: stats.disk.usedPercent,
                    detail: [
                        RelayMachineStats.bytesText(stats.disk.freeBytes).map { "\($0) free" },
                        stats.historyWindowLabel
                    ]
                    .compactMap { $0 }
                    .joined(separator: " · "),
                    points: percentPoints(stats, \.diskUsedPercent, current: stats.disk.usedPercent),
                    firing: isFiring(stats, .disk)
                )
                if stats.showsNetwork {
                    rateChart(
                        title: "Network",
                        inboundTitle: "In",
                        outboundTitle: "Out",
                        inbound: stats.network?.rxBytesPerSec,
                        outbound: stats.network?.txBytesPerSec,
                        inboundPoints: ratePoints(stats, \.netRxBytesPerSec, series: "In", current: stats.network?.rxBytesPerSec),
                        outboundPoints: ratePoints(stats, \.netTxBytesPerSec, series: "Out", current: stats.network?.txBytesPerSec)
                    )
                }
                if stats.showsDiskIO {
                    rateChart(
                        title: "Disk I/O",
                        inboundTitle: "Read",
                        outboundTitle: "Write",
                        inbound: stats.io?.readBytesPerSec,
                        outbound: stats.io?.writeBytesPerSec,
                        inboundPoints: ratePoints(stats, \.diskReadBytesPerSec, series: "Read", current: stats.io?.readBytesPerSec),
                        outboundPoints: ratePoints(stats, \.diskWriteBytesPerSec, series: "Write", current: stats.io?.writeBytesPerSec)
                    )
                }
                loadFooter(stats)
            }
            .padding(.horizontal, 22)
            .padding(.top, 8)
            .padding(.bottom, 36)
        }
    }

    private func header(_ stats: RelayMachineStats) -> some View {
        statusHeader(
            status: stats.firingAlerts.isEmpty ? "Reachable" : "Under load",
            warn: !stats.firingAlerts.isEmpty,
            name: stats.host.hostname ?? machineName,
            uptime: RelayMachineStats.uptimeText(stats.host.uptimeSec),
            updated: stats.lastUpdatedText,
            info: Self.usageInfo
        )
    }

    private func statusPage(status: String, warn: Bool, info: String) -> some View {
        statusHeader(status: status, warn: warn, info: info)
            .padding(22)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func statusHeader(
        status: String,
        warn: Bool,
        name: String? = nil,
        uptime: String? = nil,
        updated: String? = nil,
        info: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                RelayCapsLabel(
                    text: status,
                    color: warn ? AppTheme.statusWarn : AppTheme.textTertiary,
                    size: 10
                )
                Spacer()
                if let updated {
                    Text(updated)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textTertiary)
                        .monospacedDigit()
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(name ?? machineName)
                    .font(AppTheme.serifFont(size: 26))
                    .foregroundStyle(AppTheme.textPrimary)
                RelayInfoButton(title: "Usage", message: info)
            }
            Text(uptime.map { "This machine · up \($0)" } ?? "This machine")
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
            if canControlPower {
                RelayMachinePowerSwitch(
                    model: powerModel,
                    onStarted: {
                        await waitForMachine()
                    },
                    confirmStop: { showingStopPower = true },
                    accessibilityIdentifier: "relay-usage-power"
                )
            }
        }
    }

    private func attention(_ stats: RelayMachineStats) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            RelayCapsLabel(text: "Needs attention", color: AppTheme.statusWarn, size: 10)
            ForEach(stats.firingAlerts) { alert in
                Text(alert.firingCopy)
                    .font(AppTheme.uiFont(size: 16))
                    .foregroundStyle(AppTheme.statusWarn)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func percentChart(
        title: String,
        value: Double?,
        detail: String,
        points: [RelayUsagePoint],
        firing: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            chartHeading(
                title: title,
                value: value.map(RelayMachineStats.percentText) ?? "—",
                detail: detail,
                emphasize: firing
            )
            usageChart(points: points, yDomain: 0...100, firing: firing, rateAxis: false)
        }
    }

    private func rateChart(
        title: String,
        inboundTitle: String,
        outboundTitle: String,
        inbound: Double?,
        outbound: Double?,
        inboundPoints: [RelayUsagePoint],
        outboundPoints: [RelayUsagePoint]
    ) -> some View {
        let points = inboundPoints + outboundPoints
        let peak = max(points.map(\.value).max() ?? 0, 1) * 1.15
        return VStack(alignment: .leading, spacing: 10) {
            chartHeading(
                title: title,
                value: "\(inboundTitle) \(RelayMachineStats.rateText(inbound))",
                detail: "\(outboundTitle) \(RelayMachineStats.rateText(outbound)) · \(model.stats?.historyWindowLabel ?? "Recent")",
                emphasize: false
            )
            usageChart(points: points, yDomain: 0...peak, firing: false, dualSeries: true, rateAxis: true)
        }
    }

    private func chartHeading(title: String, value: String, detail: String, emphasize: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(title)
                    .font(AppTheme.uiFont(size: 15))
                    .foregroundStyle(AppTheme.textSecondary)
                Spacer()
                Text(value)
                    .font(AppTheme.monoFont(size: 18))
                    .foregroundStyle(emphasize ? AppTheme.statusWarn : AppTheme.textPrimary)
            }
            if !detail.isEmpty {
                Text(detail)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textTertiary)
            }
        }
    }

    private func usageChart(
        points: [RelayUsagePoint],
        yDomain: ClosedRange<Double>,
        firing: Bool,
        dualSeries: Bool = false,
        rateAxis: Bool = false
    ) -> some View {
        let span = points.count >= 2
            ? points[points.count - 1].date.timeIntervalSince(points[0].date)
            : 0
        return Chart(points) { point in
            if !dualSeries {
                AreaMark(
                    x: .value("Time", point.date),
                    y: .value("Value", point.value)
                )
                .foregroundStyle((firing ? AppTheme.statusWarn : AppTheme.textPrimary).opacity(0.16))
                .interpolationMethod(.linear)
            }
            LineMark(
                x: .value("Time", point.date),
                y: .value("Value", point.value),
                series: .value("Series", point.series)
            )
            .foregroundStyle(lineColor(series: point.series, firing: firing, dualSeries: dualSeries))
            .lineStyle(StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
            .interpolationMethod(.linear)
        }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { _ in
                AxisGridLine().foregroundStyle(AppTheme.hairline)
                if span < 180 {
                    AxisValueLabel(format: .dateTime.minute().second())
                        .foregroundStyle(AppTheme.textFaint)
                        .font(AppTheme.uiFont(size: 10))
                } else {
                    AxisValueLabel(format: .dateTime.hour().minute())
                        .foregroundStyle(AppTheme.textFaint)
                        .font(AppTheme.uiFont(size: 10))
                }
            }
        }
        .chartYAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisGridLine().foregroundStyle(AppTheme.hairline)
                if rateAxis, let bytes = value.as(Double.self) {
                    AxisValueLabel {
                        Text(RelayMachineStats.rateText(bytes))
                            .foregroundStyle(AppTheme.textFaint)
                            .font(AppTheme.uiFont(size: 10))
                    }
                } else {
                    AxisValueLabel()
                        .foregroundStyle(AppTheme.textFaint)
                        .font(AppTheme.uiFont(size: 10))
                }
            }
        }
        .chartYScale(domain: yDomain)
        .chartLegend(.hidden)
        .chartPlotStyle { plot in
            plot.background(AppTheme.textPrimary.opacity(0.03))
        }
        .frame(height: 104)
        .accessibilityHidden(true)
    }

    private func loadFooter(_ stats: RelayMachineStats) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Rectangle()
                .fill(AppTheme.hairline)
                .frame(height: 1)
            Text(loadLine(stats))
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textTertiary)
        }
    }

    private func isFiring(_ stats: RelayMachineStats, _ kind: RelayMachineStats.Alert.Kind) -> Bool {
        stats.alerts.contains { $0.kind == kind && $0.state == .firing }
    }

    private var canControlPower: Bool { identityStore?.wakeCredential() != nil }

    /// Usage can fail because the machine is stopped or because it is simply
    /// unreachable, and only the power read tells us which. Say nothing until
    /// that read lands.
    private var unreachableStatusLabel: String {
        guard !isPowerStatePending else { return "Checking" }
        return powerModel.status == .off ? "Off" : "Unreachable"
    }

    private var isPowerStatePending: Bool {
        canControlPower && !powerModel.status.isResolved
    }

    private func waitForMachine() async {
        let deadline = Date().addingTimeInterval(60)
        while Date() < deadline {
            await model.refresh(client: client)
            if model.stats != nil { return }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private func loadLine(_ stats: RelayMachineStats) -> String {
        let loads = [stats.cpu.load1, stats.cpu.load5, stats.cpu.load15]
            .compactMap { value -> String? in
                guard let value else { return nil }
                return String(format: "%.2f", value)
            }
        let load = loads.isEmpty ? nil : "Load \(loads.joined(separator: " / "))"
        let runs = "\(stats.jobs.active) active · \(stats.jobs.queued) queued"
        return [load, runs].compactMap { $0 }.joined(separator: "  ·  ")
    }

    private func lineColor(series: String, firing: Bool, dualSeries: Bool) -> Color {
        if firing { return AppTheme.statusWarn }
        if dualSeries && (series == "Out" || series == "Write") {
            return AppTheme.textSecondary
        }
        return AppTheme.textPrimary
    }

    private func percentPoints(
        _ stats: RelayMachineStats,
        _ keyPath: KeyPath<RelayMachineStats.Sample, Double?>,
        current: Double?
    ) -> [RelayUsagePoint] {
        points(from: stats.history, keyPath: keyPath, series: "main", current: current)
    }

    private func ratePoints(
        _ stats: RelayMachineStats,
        _ keyPath: KeyPath<RelayMachineStats.Sample, Double?>,
        series: String,
        current: Double?
    ) -> [RelayUsagePoint] {
        points(from: stats.history, keyPath: keyPath, series: series, current: current)
    }

    private func points(
        from history: [RelayMachineStats.Sample],
        keyPath: KeyPath<RelayMachineStats.Sample, Double?>,
        series: String,
        current: Double?
    ) -> [RelayUsagePoint] {
        var result: [RelayUsagePoint] = []
        for (index, sample) in history.enumerated() {
            guard let value = sample[keyPath: keyPath],
                  let date = RelayMachineStats.parseDate(sample.ts)
            else { continue }
            result.append(RelayUsagePoint(id: "\(series)-\(sample.ts ?? "\(index)")", date: date, value: value, series: series))
        }
        if result.isEmpty, let current {
            let now = Date()
            result = [
                RelayUsagePoint(id: "\(series)-a", date: now.addingTimeInterval(-15), value: current, series: series),
                RelayUsagePoint(id: "\(series)-b", date: now, value: current, series: series)
            ]
        }
        return downsample(result, maximumCount: 240)
    }

    /// Keep Swift Charts work bounded even after an hour of five-second live
    /// samples. Min/max pairs retain short spikes better than a simple stride.
    private func downsample(_ points: [RelayUsagePoint], maximumCount: Int) -> [RelayUsagePoint] {
        guard points.count > maximumCount, maximumCount >= 4 else { return points }
        let interior = points.count - 2
        let bucketCount = max(1, (maximumCount - 2) / 2)
        let bucketSize = (interior + bucketCount - 1) / bucketCount
        var sampled: [RelayUsagePoint] = [points[0]]
        sampled.reserveCapacity(maximumCount)

        var start = 1
        while start < points.count - 1 {
            let end = min(start + bucketSize, points.count - 1)
            let indices = start..<end
            guard let minimum = indices.min(by: { points[$0].value < points[$1].value }),
                  let maximum = indices.max(by: { points[$0].value < points[$1].value })
            else { break }
            for index in [minimum, maximum].sorted() {
                if sampled.last?.id != points[index].id {
                    sampled.append(points[index])
                }
            }
            start = end
        }
        sampled.append(points[points.count - 1])
        return sampled
    }

    static let usageInfo =
        "Numbers stay on this computer. Relay notifies your phone when something stays high or the machine goes quiet, and only if this machine is connected to your account."

    static let powerInfo =
        "Start and stop use a wake token this phone received when it paired. No Relay account. Jobs and files still go only to this machine."

    static let unsupportedInfo =
        "This machine's Relay service is too old to report usage. Update relayd on that computer, then open Usage again."
}
