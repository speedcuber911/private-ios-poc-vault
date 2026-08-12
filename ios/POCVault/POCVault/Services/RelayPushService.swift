import Foundation
import UIKit
import UserNotifications

/// Where a tapped notification should take the user.
enum RelayPushRoute: Equatable {
    case handoff(nodeID: String)
    case job(nodeID: String, jobID: String)
    case none
}

/// APNs registration and routing.
///
/// The payload the cloud sends is deliberately content-free — a node id, an
/// event type, a timestamp and a sequence, under a top-level `relay` key
/// (`cloud/src/apns.js` sends `{aps, relay}`). Nothing user-visible travels in
/// the push: every detail is loaded from the node over mTLS after the tap, so a
/// notification can never leak a title, a transcript or a credential.
@MainActor
final class RelayPushService: NSObject, ObservableObject, UNUserNotificationCenterDelegate {

    @Published private(set) var pendingRoute: RelayPushRoute?
    @Published private(set) var isRegistered = false

    private let accountStore: RelayAccountStore
    private let authBaseURL: URL
    private let session: URLSession
    /// The token iOS handed us before an account session existed. Registration
    /// needs a bearer token, and the token only arrives once per launch, so it
    /// is held here until sign-in makes the call possible.
    private var pendingDeviceToken: Data?

    init(
        accountStore: RelayAccountStore,
        authBaseURL: URL = AppConfiguration.authBaseURL,
        session: URLSession = .shared
    ) {
        self.accountStore = accountStore
        self.authBaseURL = authBaseURL
        self.session = session
        super.init()
    }

    /// Ask once, then register with APNs. Declining is a normal outcome: the app
    /// keeps working, it just will not be told when a handoff lands.
    func registerForPushNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else {
                CodexDiagnostics.log("push_authorization_denied")
                return
            }
            Task { @MainActor in
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Registers this device's APNs token with the cloud so the account's pushes
    /// reach it. The token is device-scoped and carries no account data.
    func handleDeviceToken(_ token: Data) async {
        pendingDeviceToken = token
        guard let sessionToken = accountStore.currentSessionToken else {
            CodexDiagnostics.log("push_register_deferred")
            return
        }

        var request = URLRequest(url: authBaseURL.appendingPathComponent("v1/devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(sessionToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "apnsToken": Self.hexToken(from: token),
            "platform": "ios",
            "name": UIDevice.current.name
        ])

        do {
            let (_, response) = try await session.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            isRegistered = (200...299).contains(status)
            if isRegistered { pendingDeviceToken = nil }
            // The token itself is never logged.
            CodexDiagnostics.log("push_register", fields: ["status": String(status)])
        } catch {
            CodexDiagnostics.log("push_register_failed", fields: ["error": String(describing: error)])
        }
    }

    /// Retry a registration that could not run because no account session existed
    /// when APNs delivered the token. Safe to call on every foreground.
    func registerPendingDeviceTokenIfNeeded() async {
        guard !isRegistered, let token = pendingDeviceToken else { return }
        await handleDeviceToken(token)
    }

    func clearPendingRoute() { pendingRoute = nil }

    nonisolated static func hexToken(from token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// Pure routing, so the contract is testable without a device.
    nonisolated static func route(from userInfo: [AnyHashable: Any]) -> RelayPushRoute {
        guard let relay = userInfo["relay"] as? [AnyHashable: Any],
              let nodeID = (relay["nodeId"] as? String)?.trimmedNonEmpty,
              let type = (relay["type"] as? String)?.trimmedNonEmpty else { return .none }

        if type.hasPrefix("handoff.") { return .handoff(nodeID: nodeID) }
        if type.hasPrefix("job."), let jobID = (relay["jobId"] as? String)?.trimmedNonEmpty {
            return .job(nodeID: nodeID, jobID: jobID)
        }
        return .none
    }

    // MARK: - UNUserNotificationCenterDelegate

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let route = Self.route(from: response.notification.request.content.userInfo)
        guard route != .none else { return }
        await MainActor.run { self.pendingRoute = route }
    }
}

/// Minimal app delegate: iOS delivers the APNs device token nowhere else.
final class RelayAppDelegate: NSObject, UIApplicationDelegate {
    static weak var pushService: RelayPushService?

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        Task { @MainActor in
            await Self.pushService?.handleDeviceToken(deviceToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        CodexDiagnostics.log("push_token_failed", fields: ["error": String(describing: error)])
    }
}
