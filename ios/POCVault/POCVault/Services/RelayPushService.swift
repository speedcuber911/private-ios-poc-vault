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
/// The routing payload is content-free — a node id, an event type, a timestamp
/// and a sequence, under a top-level `relay` key (`cloud/src/apns.js` sends
/// `{aps, relay}`). Everything this file reads comes from there.
///
/// The banner beside it (`aps.alert`) is not content-free, and deliberately so:
/// a handoff banner names the repository and the branch, because a
/// notification that cannot say WHICH session is ready is not worth the
/// interruption. That is the whole of it — `cloud/src/notify.js` `bannerFor` is
/// the single place that decides the text, and no transcript, prompt, manifest
/// or credential is ever in it. Job details are still loaded from the node over
/// mTLS after the tap.
@MainActor
final class RelayPushService: NSObject, ObservableObject, UNUserNotificationCenterDelegate {

    private static let approveAction = "RELAY_APPROVE"
    private static let denyAction = "RELAY_DENY"

    @Published private(set) var pendingRoute: RelayPushRoute?
    @Published private(set) var isRegistered = false

    private let accountStore: RelayAccountStore
    private let authBaseURL: URL
    private let session: URLSession
    private let codexClient: CodexClient
    /// The token iOS handed us before an account session existed. Registration
    /// needs a bearer token, and the token only arrives once per launch, so it
    /// is held here until sign-in makes the call possible.
    private var pendingDeviceToken: Data?

    init(
        accountStore: RelayAccountStore,
        codexClient: CodexClient,
        authBaseURL: URL = AppConfiguration.authBaseURL,
        session: URLSession = .shared
    ) {
        self.accountStore = accountStore
        self.codexClient = codexClient
        self.authBaseURL = authBaseURL
        self.session = session
        super.init()
    }

    /// Ask once, then register with APNs. Declining is a normal outcome: the app
    /// keeps working, it just will not be told when a handoff lands.
    func registerForPushNotifications() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(
                identifier: "RELAY_NEEDS_INPUT",
                actions: [
                    UNNotificationAction(identifier: Self.approveAction, title: "Approve", options: [.foreground]),
                    UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
                ],
                intentIdentifiers: []
            )
        ])
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
            "name": UIDevice.current.name,
            "apnsEnvironment": Self.apnsEnvironment
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

    /// Which APNs environment this build's device token is valid against.
    ///
    /// A token only works against the environment that minted it. Send a
    /// TestFlight token to the sandbox host (or the reverse) and Apple answers
    /// `400 BadDeviceToken`, which looks exactly like a dead token — the cloud
    /// used to delete it on that basis, and one wrong `APNS_HOST` wiped every
    /// token on the account. The server now routes per device, but only if the
    /// device says which one it is.
    ///
    /// Read from the embedded provisioning profile's `aps-environment`
    /// entitlement, which is the authority: it is what Apple actually issued
    /// the token under. `#if DEBUG` is NOT that authority — a Release build
    /// installed from Xcode still gets a development token, and would lie.
    ///
    /// App Store builds ship no `embedded.mobileprovision`; that absence only
    /// happens for App Store distribution, which is always production.
    static let apnsEnvironment: String = {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let raw = try? Data(contentsOf: url) else {
            return "production" // no profile ⇒ App Store build
        }
        // The file is CMS-wrapped; the embedded plist is plain XML inside it,
        // so scan for the entitlement rather than decoding the signature.
        guard let text = String(data: raw, encoding: .ascii),
              let range = text.range(of: "<key>aps-environment</key>") else {
            return "production"
        }
        let tail = text[range.upperBound...].prefix(200)
        return tail.contains("<string>development</string>") ? "development" : "production"
    }()

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
        if case .job(_, let jobID) = route {
            if response.actionIdentifier == "RELAY_APPROVE" {
                try? await codexClient.decideFirstPendingApproval(jobID: jobID, decision: .accept)
            } else if response.actionIdentifier == "RELAY_DENY" {
                try? await codexClient.decideFirstPendingApproval(jobID: jobID, decision: .decline)
            }
        }
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
