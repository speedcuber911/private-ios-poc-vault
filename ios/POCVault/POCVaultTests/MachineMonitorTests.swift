import XCTest
@testable import POCVault

final class MachineMonitorTests: XCTestCase {
    func testDecodesHostUsageSnapshot() throws {
        let json = """
        {
          "ok": true,
          "sampledAt": "2026-09-19T10:00:00.000Z",
          "host": { "hostname": "box-1", "platform": "linux", "arch": "x64", "uptimeSec": 90000 },
          "cpu": { "usedPercent": 12.4, "count": 4, "load1": 0.3, "load5": 0.4, "load15": 0.5 },
          "memory": { "usedPercent": 41.2, "usedBytes": 410, "totalBytes": 1000, "availableBytes": 590 },
          "disk": { "usedPercent": 67.0, "usedBytes": 670, "totalBytes": 1000, "freeBytes": 330, "path": "/" },
          "jobs": { "active": 1, "queued": 0 },
          "network": { "rxBytesPerSec": 1200, "txBytesPerSec": 300 },
          "io": { "readBytesPerSec": 4096, "writeBytesPerSec": 512, "readOpsPerSec": 2, "writeOpsPerSec": 1 },
          "alerts": [
            { "kind": "cpu", "state": "ok" },
            { "kind": "memory", "state": "ok" },
            { "kind": "disk", "state": "firing" }
          ],
          "history": [
            {
              "ts": "2026-09-19T09:42:00.000Z",
              "cpuPercent": 10.0,
              "memoryUsedPercent": 40.0,
              "diskUsedPercent": 66.0,
              "netRxBytesPerSec": 800,
              "netTxBytesPerSec": 200,
              "diskReadBytesPerSec": 1024,
              "diskWriteBytesPerSec": 256
            },
            {
              "ts": "2026-09-19T10:00:00.000Z",
              "cpuPercent": 12.4,
              "memoryUsedPercent": 41.2,
              "diskUsedPercent": 67.0,
              "netRxBytesPerSec": 1200,
              "netTxBytesPerSec": 300,
              "diskReadBytesPerSec": 4096,
              "diskWriteBytesPerSec": 512
            }
          ]
        }
        """.data(using: .utf8)!

        let stats = try JSONDecoder().decode(RelayMachineStats.self, from: json)
        XCTAssertEqual(stats.host.hostname, "box-1")
        XCTAssertEqual(stats.cpu.usedPercent, 12.4)
        XCTAssertEqual(stats.jobs.active, 1)
        XCTAssertEqual(stats.network?.rxBytesPerSec, 1200)
        XCTAssertEqual(stats.io?.writeBytesPerSec, 512)
        XCTAssertTrue(stats.showsNetwork)
        XCTAssertEqual(stats.historyWindowLabel, "Last 18 min")
        XCTAssertEqual(stats.firingAlerts.map(\.kind), [.disk])
        XCTAssertEqual(stats.summaryLine, "CPU 12% · Mem 41% · Disk 67%")
        XCTAssertEqual(RelayMachineStats.uptimeText(90_000), "1d 1h")
        XCTAssertEqual(RelayMachineStats.percentText(12.4), "12%")
        XCTAssertEqual(RelayMachineStats.rateText(1200), "1.2 KB/s")
        XCTAssertNotNil(stats.lastUpdatedText)
        XCTAssertNotNil(RelayMachineStats.parseDate("2026-09-19T14:38:01.234Z"))
        XCTAssertNotNil(RelayMachineStats.parseDate("2026-09-19T14:38:01Z"))

        let payload = try XCTUnwrap(String(data: json, encoding: .utf8))
        guard case .snapshot(let streamed)? = CodexClient.decodeMachineStatsEvent(
            event: "snapshot",
            data: payload
        ) else {
            return XCTFail("Expected a machine stats snapshot event")
        }
        XCTAssertEqual(streamed.host.hostname, "box-1")
        XCTAssertNil(CodexClient.decodeMachineStatsEvent(event: "future", data: payload))

        let latestOnly = RelayMachineStats(
            ok: stats.ok,
            sampledAt: stats.sampledAt,
            host: stats.host,
            cpu: stats.cpu,
            memory: stats.memory,
            disk: stats.disk,
            jobs: stats.jobs,
            network: stats.network,
            io: stats.io,
            alerts: stats.alerts,
            history: [try XCTUnwrap(stats.history.last)]
        )
        let merged = stats.mergingLiveSample(latestOnly)
        XCTAssertEqual(merged.history.count, stats.history.count)
        XCTAssertEqual(merged.history.last, latestOnly.history.last)
    }

    func testUsageExplainersLiveOnTheInfoControl() throws {
        let source = try AppSourceFixture.load("POCVault/Views/RelayMachineMonitorView.swift")
        XCTAssertTrue(source.contains("RelayInfoButton"))
        XCTAssertTrue(source.contains("unsupportedInfo"))
        XCTAssertTrue(source.contains("powerInfo"))
        XCTAssertTrue(source.contains("Start machine"))
        XCTAssertTrue(source.contains(".task(id: scenePhase)"))
        XCTAssertTrue(source.contains("await model.monitor(client: client)"))
        XCTAssertTrue(source.contains("client.streamMachineStats()"))
        XCTAssertTrue(source.contains("mergingLiveSample"))
        XCTAssertTrue(source.contains(".seconds(5)"))
        XCTAssertFalse(source.contains("nonisolated(unsafe) private var pollTask"))
        XCTAssertFalse(source.contains(".onAppear { model.start"))
        XCTAssertFalse(source.contains(".id(sampledAt"))
        XCTAssertFalse(source.contains("15_000_000_000"))
        XCTAssertFalse(source.contains("placeholder("))
    }

    func testUnknownAlertKindDoesNotFailDecode() throws {
        let json = """
        {
          "ok": true,
          "sampledAt": null,
          "host": {},
          "cpu": {},
          "memory": {},
          "disk": {},
          "jobs": { "active": 0, "queued": 0 },
          "alerts": [{ "kind": "gpu", "state": "firing" }],
          "history": []
        }
        """.data(using: .utf8)!

        let stats = try JSONDecoder().decode(RelayMachineStats.self, from: json)
        XCTAssertEqual(stats.firingAlerts.first?.kind, .unknown)
        XCTAssertEqual(stats.summaryLine, "Usage")
    }
}
