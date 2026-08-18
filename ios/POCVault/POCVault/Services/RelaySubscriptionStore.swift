import CryptoKit
import Foundation
import StoreKit

@MainActor
final class RelaySubscriptionStore: ObservableObject {
    static let hostedMonthlyProductID = "com.parikshit.pocvault.hosted.monthly"
    static let hostedYearlyProductID = "com.parikshit.pocvault.hosted.yearly"

    @Published private(set) var monthlyProduct: Product?
    @Published private(set) var yearlyProduct: Product?
    @Published private(set) var isActive = false
    @Published private(set) var isLoading = false
    @Published private(set) var isPurchasing = false
    @Published var errorMessage: String?

    private let accountStore: RelayAccountStore
    private let nodeStore: RelayNodeStore
    private let client: RelaySubscriptionClient
    private var updatesTask: Task<Void, Never>?

    init(
        accountStore: RelayAccountStore,
        nodeStore: RelayNodeStore,
        client: RelaySubscriptionClient
    ) {
        self.accountStore = accountStore
        self.nodeStore = nodeStore
        self.client = client
        updatesTask = Task { [weak self] in
            for await verification in Transaction.updates {
                guard !Task.isCancelled else { return }
                await self?.accept(verification)
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    var monthlyDisplayPrice: String { monthlyProduct?.displayPrice ?? "$9.99" }
    var yearlyDisplayPrice: String { yearlyProduct?.displayPrice ?? "$99" }

    func prepare() async {
        guard accountStore.user != nil else { return }
        isLoading = true
        isActive = false
        errorMessage = nil
        defer { isLoading = false }
        do {
            let products = try await Product.products(for: [
                Self.hostedMonthlyProductID,
                Self.hostedYearlyProductID
            ])
            monthlyProduct = products.first { $0.id == Self.hostedMonthlyProductID }
            yearlyProduct = products.first { $0.id == Self.hostedYearlyProductID }
            try await submitCurrentEntitlement(showMissingError: false)
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func purchase(productID: String = RelaySubscriptionStore.hostedMonthlyProductID) async {
        guard !isPurchasing else { return }
        let selectedProduct = productID == Self.hostedYearlyProductID
            ? yearlyProduct
            : monthlyProduct
        guard let selectedProduct else {
            await prepare()
            let loadedProduct = productID == Self.hostedYearlyProductID
                ? yearlyProduct
                : monthlyProduct
            guard loadedProduct != nil else {
                errorMessage = "Relay Hosted isn't available from the App Store right now. Try again shortly."
                return
            }
            return await purchase(productID: productID)
        }
        guard let accountID = accountStore.user?.id else {
            errorMessage = "Sign in to subscribe to Relay Hosted."
            return
        }

        isPurchasing = true
        errorMessage = nil
        defer { isPurchasing = false }
        do {
            let result = try await selectedProduct.purchase(options: [
                .appAccountToken(Self.appAccountToken(accountID: accountID))
            ])
            switch result {
            case .success(let verification):
                try await acceptVerified(verification)
            case .pending:
                errorMessage = "The purchase is pending approval in the App Store."
            case .userCancelled:
                break
            @unknown default:
                errorMessage = "The App Store returned an unknown purchase result."
            }
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    func restorePurchases() async {
        guard !isPurchasing else { return }
        isPurchasing = true
        errorMessage = nil
        defer { isPurchasing = false }
        do {
            try await AppStore.sync()
            try await submitCurrentEntitlement(showMissingError: true)
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    static func appAccountToken(accountID: String) -> UUID {
        var bytes = Array(
            SHA256.hash(data: Data("relay-app-account-v1\0\(accountID)".utf8)).prefix(16)
        )
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        return UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11],
            bytes[12], bytes[13], bytes[14], bytes[15]
        ))
    }

    private func submitCurrentEntitlement(showMissingError: Bool) async throws {
        guard let accountID = accountStore.user?.id else {
            throw RelaySubscriptionError.signedOut
        }
        let expectedToken = Self.appAccountToken(accountID: accountID)
        for await verification in Transaction.currentEntitlements {
            guard case .verified(let transaction) = verification,
                  Self.hostedProductIDs.contains(transaction.productID),
                  transaction.appAccountToken == expectedToken else { continue }
            try await acceptVerified(verification)
            return
        }
        isActive = false
        if showMissingError {
            errorMessage = "No active Relay Hosted subscription was found for this Apple ID."
        }
    }

    private func accept(_ verification: VerificationResult<Transaction>) async {
        do {
            try await acceptVerified(verification)
        } catch {
            errorMessage = friendlyMessage(for: error)
        }
    }

    private func acceptVerified(_ verification: VerificationResult<Transaction>) async throws {
        guard case .verified(let transaction) = verification else {
            throw RelaySubscriptionError.unverifiedTransaction
        }
        guard Self.hostedProductIDs.contains(transaction.productID) else { return }
        guard let accountID = accountStore.user?.id,
              let bearer = accountStore.currentSessionToken else {
            throw RelaySubscriptionError.signedOut
        }
        guard transaction.appAccountToken == Self.appAccountToken(accountID: accountID) else {
            throw RelaySubscriptionError.accountMismatch
        }
        let response = try await client.verify(
            signedTransaction: verification.jwsRepresentation,
            bearer: bearer
        )
        if let trial = response.trial {
            nodeStore.updateTrial(trial)
        }
        isActive = response.subscription.status == "active"
        await transaction.finish()
    }

    private func friendlyMessage(for error: Error) -> String {
        if let subscriptionError = error as? RelaySubscriptionError {
            return subscriptionError.localizedDescription
        }
        return "Relay couldn't confirm the subscription. Your purchase is safe; use Restore Purchases to retry."
    }

    private static let hostedProductIDs: Set<String> = [
        hostedMonthlyProductID,
        hostedYearlyProductID
    ]
}

struct RelaySubscriptionResponse: Decodable {
    struct Subscription: Decodable {
        let productId: String
        let status: String
        let expiresAt: Int64
    }
    let subscription: Subscription
    let trial: RelayTrialNode?
}

enum RelaySubscriptionError: LocalizedError {
    case signedOut
    case unverifiedTransaction
    case accountMismatch
    case server(status: Int, code: String?)

    var errorDescription: String? {
        switch self {
        case .signedOut:
            return "Sign in to manage Relay Hosted."
        case .unverifiedTransaction:
            return "The App Store couldn't verify this purchase."
        case .accountMismatch:
            return "This subscription is linked to a different Relay account."
        case .server(_, let code) where code == "subscription_account_mismatch":
            return "This subscription is linked to a different Relay account."
        case .server(_, let code) where code == "subscription_inactive":
            return "The Relay Hosted subscription is no longer active."
        case .server:
            return "Relay couldn't confirm the subscription. Use Restore Purchases to retry."
        }
    }
}

final class RelaySubscriptionClient {
    private let baseURL: URL
    private let session: URLSession

    init(baseURL: URL, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.session = session
    }

    func verify(signedTransaction: String, bearer: String) async throws -> RelaySubscriptionResponse {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        let basePath = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + [basePath, "v1/subscriptions/apple/verify"]
            .filter { !$0.isEmpty }
            .joined(separator: "/")
        components.query = nil
        components.fragment = nil

        var request = URLRequest(url: components.url!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONEncoder().encode([
            "signedTransaction": signedTransaction
        ])

        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else {
            throw RelaySubscriptionError.server(status: 0, code: nil)
        }
        guard (200..<300).contains(response.statusCode) else {
            struct ErrorPayload: Decodable { let error: String? }
            let code = (try? JSONDecoder().decode(ErrorPayload.self, from: data))?.error
            throw RelaySubscriptionError.server(status: response.statusCode, code: code)
        }
        return try JSONDecoder().decode(RelaySubscriptionResponse.self, from: data)
    }
}
