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
