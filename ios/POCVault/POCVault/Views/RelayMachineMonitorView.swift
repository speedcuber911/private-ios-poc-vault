import SwiftUI

@MainActor
final class RelayMachineMonitorModel: ObservableObject {
    @Published var stats: RelayMachineStats?
    @Published var errorMessage: String?
    @Published var isLoading = false
    @Published var unsupported = false

    init(stats: RelayMachineStats? = nil) {
        self.stats = stats
    }

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

struct RelayMachineMonitorView: View {
    let client: CodexClient
    var identityStore: ClientIdentityStore? = nil
    let machineName: String
    var showsDismissButton = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: RelayMachineMonitorModel
    @StateObject private var powerModel = RelayMachinePowerModel()
    @State private var showingStopPower = false
    @State private var showingResize = false

    /// `initialStats` seeds the first frame (previews and snapshot tests);
    /// live data replaces it as soon as the stream opens.
    init(
        client: CodexClient,
        identityStore: ClientIdentityStore? = nil,
        machineName: String,
        showsDismissButton: Bool = false,
        initialStats: RelayMachineStats? = nil
    ) {
        self.client = client
        self.identityStore = identityStore
        self.machineName = machineName
        self.showsDismissButton = showsDismissButton
        _model = StateObject(wrappedValue: RelayMachineMonitorModel(stats: initialStats))
    }

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
                    if canControlPower {
                        RelayMachineSizeControl(model: powerModel)
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
        .task(id: powerModel.resize?.stage) {
            await powerModel.waitForResize()
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
        .modifier(RelayResizeProgressPresenter(model: powerModel))
        .preferredColorScheme(.dark)
    }

    // MARK: - btop-style usage (canvas "B · One screen")

    private func usageScroll(_ stats: RelayMachineStats) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                compactHeader(stats)
                if !stats.firingAlerts.isEmpty {
                    attention(stats)
                }
                cpuBox(stats)
                HStack(alignment: .top, spacing: 12) {
                    memoryBox(stats)
                    diskBox(stats)
                }
                .fixedSize(horizontal: false, vertical: true)
                if stats.showsNetwork {
                    networkBox(stats)
                }
                if let processes = stats.processes, !processes.isEmpty {
                    processBox(processes)
                }
                Text("\(stats.jobs.active) runs active · \(stats.jobs.queued) queued")
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 36)
        }
        .sheet(isPresented: $showingResize) {
            resizeSheet
        }
    }

    private func compactHeader(_ stats: RelayMachineStats) -> some View {
        let status = stats.firingAlerts.isEmpty ? "Reachable" : "Under load"
        let caps = RelayMachineStats.uptimeText(stats.host.uptimeSec).map { "\(status) · up \($0)" } ?? status
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    RelayCapsLabel(
                        text: caps,
                        color: stats.firingAlerts.isEmpty ? AppTheme.textSecondary : AppTheme.statusWarn,
                        size: 10
                    )
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(stats.host.hostname ?? machineName)
                            .font(AppTheme.serifFont(size: 26))
                            .foregroundStyle(AppTheme.textPrimary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                        RelayInfoButton(title: "Usage", message: Self.usageInfo)
                    }
                }
                Spacer(minLength: 8)
                if canControlPower {
                    powerSwitch(showsLabel: false)
                }
            }
            if canControlPower, let instanceType = powerModel.instanceType {
                instanceRow(instanceType)
            }
        }
    }

    private func instanceRow(_ instanceType: String) -> some View {
        Button {
            showingResize = true
        } label: {
            HStack(spacing: 10) {
                Text(instanceType)
                    .font(AppTheme.monoFont(size: 13))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer(minLength: 8)
                if let resize = powerModel.resize, resize.isActive {
                    Text("Changing to \(resize.targetType)")
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.accent)
                } else if let price = priceLine(instanceType) {
                    Text(price)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { Rectangle().fill(AppTheme.hairline).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(AppTheme.hairline).frame(height: 1) }
        .accessibilityLabel("Machine size, \(instanceType)")
        .accessibilityHint("Shows sizes and prices")
        .accessibilityIdentifier("relay-usage-instance")
    }

    private var resizeSheet: some View {
        NavigationStack {
            ScrollView {
                RelayMachineSizeControl(model: powerModel)
                    .padding(22)
            }
            .background(AppTheme.bgCanvas)
            .navigationTitle("Machine size")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingResize = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(AppTheme.bgCanvas)
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
    }

    private func cpuBox(_ stats: RelayMachineStats) -> some View {
        let cores = stats.cpu.cores ?? []
        let coreHistory = stats.cpu.coreHistory ?? []
        let dense = cores.count > 16
        let loads = [stats.cpu.load1, stats.cpu.load5, stats.cpu.load15]
            .compactMap { $0.map { String(format: "%.2f", $0) } }
        return RelayMonitorBox(number: 1, title: "cpu", trailing: stats.lastUpdatedText) {
            RelayDotGraph(
                values: series(stats, \.cpuPercent, current: stats.cpu.usedPercent),
                maximum: 100,
                rows: 4,
                fill: .height(RelayHeat.load)
            )
            if !cores.isEmpty {
                LazyVGrid(
                    columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: dense ? 4 : 2),
                    alignment: .leading,
                    spacing: 6
                ) {
                    ForEach(cores.indices, id: \.self) { index in
                        coreCell(
                            index: index,
                            value: cores[index],
                            history: coreHistory.indices.contains(index) ? coreHistory[index].compactMap { $0 } : [],
                            dense: dense
                        )
                    }
                }
            }
            HStack(spacing: 10) {
                Text("total")
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(width: 38, alignment: .leading)
                RelayMeter(percent: stats.cpu.usedPercent, segments: 24)
                Text(stats.cpu.usedPercent.map(RelayMachineStats.percentText) ?? "—")
                    .foregroundStyle(isFiring(stats, .cpu) ? AppTheme.statusWarn : AppTheme.textPrimary)
                    .frame(width: 38, alignment: .trailing)
            }
            HStack {
                Text(stats.cpu.count.map { "\($0) cores" } ?? "")
                Spacer()
                if !loads.isEmpty {
                    Text("load \(loads.joined(separator: " "))")
                }
            }
            .foregroundStyle(AppTheme.textSecondary)
        }
    }

    private func coreCell(index: Int, value: Double?, history: [Double], dense: Bool) -> some View {
        let color = RelayHeat.load.color(at: min(1, (value ?? 0) / 100 + 0.1))
        return HStack(spacing: 6) {
            Text("C\(index)")
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: dense ? 28 : 22, alignment: .leading)
            if dense {
                Spacer(minLength: 0)
            } else {
                RelayDotGraph(values: history, maximum: 100, rows: 1, fill: .solid(color))
            }
            Text(value.map(RelayMachineStats.percentText) ?? "—")
                .foregroundStyle(dense ? color : AppTheme.textPrimary)
                .frame(width: 34, alignment: .trailing)
        }
        .font(AppTheme.monoFont(size: 11))
        .frame(height: 16)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Core \(index), \(value.map(RelayMachineStats.percentText) ?? "no reading")")
    }

    private func memoryBox(_ stats: RelayMachineStats) -> some View {
        let used = stats.memory.usedPercent
        return RelayMonitorBox(
            number: 2,
            title: "mem",
            trailing: stats.memory.totalBytes.map { RelayMachineStats.shortBytesText($0) },
            spacing: 7,
            horizontalPadding: 10
        ) {
            meterLabel("used", "\(RelayMachineStats.shortBytesText(stats.memory.usedBytes)) \(used.map(RelayMachineStats.percentText) ?? "—")")
            RelayMeter(percent: used, segments: 14)
            meterLabel(
                "avail",
                "\(RelayMachineStats.shortBytesText(stats.memory.availableBytes)) \(used.map { RelayMachineStats.percentText(100 - $0) } ?? "—")"
            )
            .padding(.top, 3)
            RelayMeter(percent: used.map { 100 - $0 }, segments: 14, flat: AppTheme.textSecondary)
        }
    }

    private func diskBox(_ stats: RelayMachineStats) -> some View {
        RelayMonitorBox(
            number: 3,
            title: "disk",
            trailing: stats.disk.path,
            spacing: 7,
            horizontalPadding: 10
        ) {
            meterLabel(
                "used",
                "\(RelayMachineStats.shortBytesText(stats.disk.usedBytes))/\(RelayMachineStats.shortBytesText(stats.disk.totalBytes))"
            )
            RelayMeter(percent: stats.disk.usedPercent, segments: 14)
            if stats.showsDiskIO {
                meterLabel("r", RelayMachineStats.shortRateText(stats.io?.readBytesPerSec))
                    .padding(.top, 3)
                meterLabel("w", RelayMachineStats.shortRateText(stats.io?.writeBytesPerSec))
            } else {
                meterLabel("free", RelayMachineStats.shortBytesText(stats.disk.freeBytes))
                    .padding(.top, 3)
            }
        }
    }

    private func meterLabel(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(AppTheme.textSecondary)
            Spacer(minLength: 4)
            Text(value)
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }

    private func networkBox(_ stats: RelayMachineStats) -> some View {
        let inbound = series(stats, \.netRxBytesPerSec, current: stats.network?.rxBytesPerSec)
        let outbound = series(stats, \.netTxBytesPerSec, current: stats.network?.txBytesPerSec)
        return RelayMonitorBox(number: 4, title: "net") {
            HStack(alignment: .center, spacing: 12) {
                VStack(spacing: 0) {
                    RelayDotGraph(values: inbound, maximum: peak(inbound), rows: 2, fill: .height(RelayHeat.inbound))
                    Rectangle().fill(AppTheme.hairline).frame(height: 1)
                    RelayDotGraph(values: outbound, maximum: peak(outbound), rows: 2, inverted: true, fill: .height(RelayHeat.outbound))
                }
                VStack(alignment: .trailing, spacing: 14) {
                    Text("▼ \(RelayMachineStats.rateText(stats.network?.rxBytesPerSec))")
                    Text("▲ \(RelayMachineStats.rateText(stats.network?.txBytesPerSec))")
                }
                .frame(width: 104, alignment: .trailing)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Download \(RelayMachineStats.rateText(stats.network?.rxBytesPerSec)), upload \(RelayMachineStats.rateText(stats.network?.txBytesPerSec))")
            }
        }
    }

    private func processBox(_ processes: [RelayMachineStats.Process]) -> some View {
        RelayMonitorBox(number: 5, title: "proc", trailing: "cpu ↓", spacing: 0) {
            processRow(pid: "pid", name: "program", graph: nil, cpu: "cpu%", memory: "mem", header: true)
            ForEach(processes) { process in
                let history = (process.history ?? []).compactMap { $0 }
                let cpu = process.cpuPercent ?? 0
                processRow(
                    pid: "\(process.pid)",
                    name: process.name,
                    graph: RelayDotGraph(
                        values: history,
                        maximum: max((history.max() ?? 0) * 1.2, 5),
                        rows: 1,
                        fill: .solid(RelayHeat.load.color(at: min(1, cpu / 40 + 0.1)))
                    ),
                    cpu: String(format: "%.1f", cpu),
                    memory: RelayMachineStats.shortBytesText(process.memBytes),
                    header: false
                )
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(process.name), process \(process.pid), \(String(format: "%.1f", cpu)) percent CPU, \(RelayMachineStats.shortBytesText(process.memBytes)) memory")
            }
        }
    }

    private func processRow(
        pid: String,
        name: String,
        graph: RelayDotGraph?,
        cpu: String,
        memory: String,
        header: Bool
    ) -> some View {
        HStack(spacing: 8) {
            Text(pid)
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 42, alignment: .leading)
            Text(name)
                .foregroundStyle(header ? AppTheme.textSecondary : AppTheme.textPrimary)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Group {
                if let graph { graph } else { Color.clear }
            }
            .frame(width: 52, height: 14)
            Text(cpu)
                .foregroundStyle(header ? AppTheme.textSecondary : AppTheme.textPrimary)
                .frame(width: 40, alignment: .trailing)
            Text(memory)
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 44, alignment: .trailing)
        }
        .font(AppTheme.monoFont(size: 12))
        .frame(height: header ? 22 : 26)
        .overlay(alignment: .top) {
            if !header {
                Rectangle().fill(AppTheme.textPrimary.opacity(0.07)).frame(height: 1)
            }
        }
    }

    private func series(
        _ stats: RelayMachineStats,
        _ keyPath: KeyPath<RelayMachineStats.Sample, Double?>,
        current: Double?
    ) -> [Double] {
        let values = stats.history.compactMap { $0[keyPath: keyPath] }
        if values.isEmpty, let current { return [current] }
        return values
    }

    /// Rate graphs scale to their own recent peak, like btop's auto-scaling.
    private func peak(_ values: [Double]) -> Double {
        max((values.suffix(160).max() ?? 0) * 1.1, 1)
    }

    private func priceLine(_ instanceType: String) -> String? {
        guard
            let hourly = powerModel.pricing?.hourly(for: instanceType),
            let monthly = powerModel.pricing?.monthly(for: instanceType)
        else { return nil }
        return "\(Self.price(hourly, maximumDigits: 4))/hr · \(Self.price(monthly, maximumDigits: 2))/mo"
    }

    private static func price(_ value: Double, maximumDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = 2
        formatter.maximumFractionDigits = maximumDigits
        return formatter.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    private func powerSwitch(showsLabel: Bool) -> some View {
        RelayMachinePowerSwitch(
            model: powerModel,
            onStarted: {
                await waitForMachine()
            },
            confirmStop: { showingStopPower = true },
            accessibilityIdentifier: "relay-usage-power",
            showsLabel: showsLabel
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
                powerSwitch(showsLabel: true)
                RelayMachineSizeControl(model: powerModel)
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

    static let usageInfo =
        "Numbers stay on this computer. Relay notifies your phone when something stays high or the machine goes quiet, and only if this machine is connected to your account."

    static let powerInfo =
        "Start and stop use a wake token this phone received when it paired. No Relay account. Jobs and files still go only to this machine."

    static let unsupportedInfo =
        "This machine's Relay service is too old to report usage. Update relayd on that computer, then open Usage again."
}

// MARK: - btop-style primitives

/// A hairline box with its title set into the top border — btop's panel
/// frame, drawn in Relay's tokens. The superscript number is the panel's
/// index, as in btop's hotkeys.
struct RelayMonitorBox<Content: View>: View {
    let number: Int
    let title: String
    var trailing: String? = nil
    var spacing: CGFloat = 10
    var horizontalPadding: CGFloat = 12
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: spacing) {
            content
        }
        .font(AppTheme.monoFont(size: 12))
        .padding(.top, 16)
        .padding(.bottom, 12)
        .padding(.horizontal, horizontalPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(AppTheme.hairlineStrong, lineWidth: 1)
        }
        .overlay(alignment: .topLeading) {
            HStack(alignment: .firstTextBaseline, spacing: 1) {
                Text("\(number)")
                    .font(AppTheme.monoFont(size: 9))
                    .foregroundStyle(AppTheme.accent)
                    .baselineOffset(5)
                Text(title)
                    .font(AppTheme.monoFont(size: 13))
                    .foregroundStyle(AppTheme.textPrimary)
            }
            .padding(.horizontal, 6)
            .background(AppTheme.bgCanvas)
            .offset(x: 10, y: -9)
            .accessibilityHidden(true)
        }
        .overlay(alignment: .topTrailing) {
            if let trailing {
                Text(trailing)
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .monospacedDigit()
                    .padding(.horizontal, 6)
                    .background(AppTheme.bgCanvas)
                    .offset(x: -10, y: -8)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(title)
    }
}

/// btop's braille graph as a dot matrix: every column is one sample, newest
/// at the right, each `row` four dots tall. Drawn in a Canvas rather than
/// braille glyphs so width and spacing never depend on font fallback.
struct RelayDotGraph: View {
    enum Fill {
        case height(RelayHeat.Ramp)
        case solid(Color)
    }

    let values: [Double]
    let maximum: Double
    let rows: Int
    var inverted = false
    let fill: Fill

    private static let pitch: CGFloat = 3.5
    private static let dot: CGFloat = 2.2

    var body: some View {
        Canvas { context, size in
            let pitch = Self.pitch
            let inset = (pitch - Self.dot) / 2
            let columns = max(1, Int(size.width / pitch))
            let levels = rows * 4
            let visible = Array(values.suffix(columns))
            let firstColumn = columns - visible.count
            let heights = visible.map { value -> Int in
                guard maximum > 0, value.isFinite, value > 0 else { return 0 }
                return min(levels, max(1, Int((value / maximum * Double(levels)).rounded())))
            }
            for level in 0..<levels {
                var path = Path()
                for (index, height) in heights.enumerated() where level < height {
                    let x = size.width - CGFloat(columns - (firstColumn + index)) * pitch + inset
                    let y = inverted
                        ? CGFloat(level) * pitch + inset
                        : size.height - CGFloat(level + 1) * pitch + inset
                    path.addEllipse(in: CGRect(x: x, y: y, width: Self.dot, height: Self.dot))
                }
                guard !path.isEmpty else { continue }
                let color: Color
                switch fill {
                case .height(let ramp): color = ramp.color(at: (Double(level) + 0.5) / Double(levels))
                case .solid(let solid): color = solid
                }
                context.fill(path, with: .color(color))
            }
        }
        .frame(height: CGFloat(rows * 4) * Self.pitch)
        .accessibilityHidden(true)
    }
}

/// btop's segmented meter. Filled segments take the heat color of their own
/// position, so a bar reddens only as it reaches the top of its range.
struct RelayMeter: View {
    let percent: Double?
    var segments = 24
    var flat: Color? = nil

    var body: some View {
        Canvas { context, size in
            let gap: CGFloat = 2
            let count = max(segments, 1)
            let width = (size.width - gap * CGFloat(count - 1)) / CGFloat(count)
            let value = max(0, min(100, percent ?? 0))
            var filled = Int((value / 100 * Double(count)).rounded())
            if value > 0, filled < 1 { filled = 1 }
            for index in 0..<count {
                let rect = CGRect(x: CGFloat(index) * (width + gap), y: 0, width: width, height: size.height)
                let color = index < filled
                    ? (flat ?? RelayHeat.load.color(at: Double(index) / Double(max(count - 1, 1))))
                    : AppTheme.textPrimary.opacity(0.09)
                context.fill(Path(roundedRect: rect, cornerRadius: 1), with: .color(color))
            }
        }
        .frame(height: 9)
        .accessibilityHidden(true)
    }
}

/// Editorial Ember's answer to btop's green→red: cream at rest, gold, then
/// ember, then red only when a resource is genuinely saturated.
enum RelayHeat {
    struct Ramp {
        let stops: [(position: Double, rgb: UInt32)]

        func color(at t: Double) -> Color {
            let t = max(0, min(1, t.isFinite ? t : 0))
            guard var lower = stops.first else { return AppTheme.textPrimary }
            for upper in stops.dropFirst() {
                if t <= upper.position {
                    let span = upper.position - lower.position
                    let f = span > 0 ? (t - lower.position) / span : 0
                    return Self.mix(lower.rgb, upper.rgb, f)
                }
                lower = upper
            }
            return Self.mix(lower.rgb, lower.rgb, 0)
        }

        private static func mix(_ a: UInt32, _ b: UInt32, _ f: Double) -> Color {
            func channel(_ value: UInt32, _ shift: UInt32) -> Double { Double((value >> shift) & 0xFF) / 255 }
            return Color(
                red: channel(a, 16) + (channel(b, 16) - channel(a, 16)) * f,
                green: channel(a, 8) + (channel(b, 8) - channel(a, 8)) * f,
                blue: channel(a, 0) + (channel(b, 0) - channel(a, 0)) * f
            )
        }
    }

    static let load = Ramp(stops: [(0, 0x9C968B), (0.4, 0xE0B25C), (0.7, 0xD4804A), (1, 0xD9574B)])
    static let inbound = Ramp(stops: [(0, 0x8A6A4E), (1, 0xE8965C)])
    static let outbound = Ramp(stops: [(0, 0x7D776E), (1, 0xEDE8DF)])
}
