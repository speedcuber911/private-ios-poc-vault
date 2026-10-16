import SwiftUI

@main
struct RelayWatchApp: App {
    @StateObject private var store = RelayWatchStore()
    @Environment(\.scenePhase) private var scenePhase

    private struct RefreshContext: Equatable {
        let isActive: Bool
        let isComposing: Bool
        let watchedJobID: String?
    }

    private var refreshContext: RefreshContext {
        RefreshContext(isActive: scenePhase == .active, isComposing: store.isComposing,
                       watchedJobID: store.watchedJobID)
    }

    var body: some Scene {
        WindowGroup {
            RelayWatchHome()
                .environmentObject(store)
                .tint(Color(red: 0.96, green: 0.36, blue: 0.20))
                .task(id: refreshContext) {
                    store.isSceneActive = scenePhase == .active
                    guard store.isSceneActive, !store.isComposing else { return }
                    while !Task.isCancelled {
                        await store.refresh(automatically: true)
                        guard let interval = store.automaticRefreshInterval else { return }
                        do { try await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000)) }
                        catch { return }
                    }
                }
        }
    }
}
