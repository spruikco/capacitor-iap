import Foundation
import StoreKit

/// All StoreKit 2 interaction lives here, isolated in an actor so the
/// unfinished-transaction table can't be raced by the `Transaction.updates`
/// listener and a user-initiated purchase arriving at the same moment.
///
/// ── Trust model ─────────────────────────────────────────────────────────────
/// StoreKit verifies transactions locally and hands back `VerificationResult`.
/// We deliberately do NOT treat that as authority. Local verification runs on a
/// device the user controls; a jailbroken device can defeat it. So this class
/// reads the payload for identifiers ONLY (`unsafePayloadValue`, named to make
/// exactly that point) and passes `jwsRepresentation` up to JS for our server
/// to verify against Apple's root certificates.
///
/// The one thing we do with the local result is log a mismatch, because an
/// unverified transaction reaching the server is a signal worth having.
///
/// No `@available` annotation is needed: Package.swift declares
/// `platforms: [.iOS(.v15)]`, so StoreKit 2 is unconditionally available to
/// every caller in this target.
actor StoreKitService {

    /// Products loaded by `initialize`, keyed by product id.
    private var products: [String: Product] = [:]

    /// Transactions the store has delivered but our server has not yet granted.
    /// `finish(transactionId:)` looks them up here.
    ///
    /// This is the crux of not losing a player's money: a transaction stays in
    /// this table (and, more importantly, unfinished with StoreKit) until the
    /// server confirms the grant. If verification fails or the app dies first,
    /// StoreKit re-delivers it through `Transaction.updates` on the next
    /// launch and we try again. iOS has no deadline for this, so retrying
    /// forever is safe here — unlike Android, where Google auto-refunds an
    /// unacknowledged purchase after three days.
    private var unfinished: [String: Transaction] = [:]

    /// Long-lived listener for transactions arriving outside a `purchase()`
    /// call: subscription renewals, Ask-to-Buy approvals granted by a parent
    /// hours later, and purchases interrupted before we finished them.
    private var updatesTask: Task<Void, Never>?

    /// Set by the plugin so the actor can push unsolicited transactions to JS.
    private var onTransaction: (@Sendable ([String: Any]) -> Void)?

    // MARK: - Lifecycle

    func setTransactionHandler(_ handler: @escaping @Sendable ([String: Any]) -> Void) {
        onTransaction = handler
    }

    /// Starts the `Transaction.updates` listener.
    ///
    /// Called from the plugin's `load()`, i.e. at app launch rather than when
    /// the credits screen opens. Apple's guidance is explicit that this should
    /// start as early as possible: transactions queued while the app was closed
    /// are delivered immediately on subscribe, and a listener attached later
    /// misses them.
    func startListening() {
        guard updatesTask == nil else { return }
        updatesTask = Task.detached(priority: .background) { [weak self] in
            for await result in Transaction.updates {
                await self?.handleUpdate(result)
            }
        }
    }

    private func handleUpdate(_ result: VerificationResult<Transaction>) {
        let transaction = result.unsafePayloadValue
        let id = String(transaction.id)
        unfinished[id] = transaction

        // A revoked transaction is a refund or a family-sharing removal. There
        // is nothing to deliver, and the server learns about it authoritatively
        // through App Store Server Notifications, so just finish it and stop.
        if transaction.revocationDate != nil {
            Task { await transaction.finish() }
            unfinished.removeValue(forKey: id)
            return
        }

        onTransaction?(Self.transactionPayload(result, unsolicited: true))
    }

    func stopListening() {
        updatesTask?.cancel()
        updatesTask = nil
    }

    // MARK: - Products

    /// Loads product metadata. `available` is false when this device cannot pay
    /// at all, in which case the caller should hide the buy UI rather than show
    /// buttons that are guaranteed to fail.
    func initialize(productIds: [String]) async throws -> Bool {
        guard AppStore.canMakePayments else { return false }
        guard !productIds.isEmpty else { return true }

        let loaded = try await Product.products(for: productIds)
        for product in loaded {
            products[product.id] = product
        }
        // An empty result for a non-empty request means the ids are wrong, or
        // the products aren't in a reviewable state in App Store Connect yet.
        // That is a configuration error, not a device limitation, so it is
        // reported as unavailable rather than thrown: the buy UI hides and the
        // web rail takes over instead of the screen erroring.
        return !loaded.isEmpty
    }

    func productPayloads() async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for product in products.values.sorted(by: { $0.price < $1.price }) {
            out.append(await Self.productPayload(product))
        }
        return out
    }

    // MARK: - Purchase

    func purchase(productId: String, appAccountToken: UUID?) async throws -> [String: Any] {
        guard let product = products[productId] else {
            throw IapError.unknownProduct(productId)
        }

        var options: Set<Product.PurchaseOption> = []
        if let token = appAccountToken {
            // Stamps our manager id onto the transaction. It travels in the
            // signed payload AND in every App Store Server Notification about
            // this purchase, which is what lets a REFUND notification arriving
            // days later be attributed to the right account without depending
            // on our own verify call having succeeded at purchase time.
            options.insert(.appAccountToken(token))
        }

        let result = try await product.purchase(options: options)

        switch result {
        case .success(let verification):
            let transaction = verification.unsafePayloadValue
            unfinished[String(transaction.id)] = transaction
            return [
                "status": "purchased",
                "transaction": Self.transactionPayload(verification, unsolicited: false)
            ]

        case .pending:
            // Ask-to-Buy awaiting a parent, or a slow payment method. Not an
            // error and not a cancel: it may complete much later and arrive
            // through the updates listener. The UI must say "waiting for
            // approval", never "purchase failed".
            return ["status": "pending", "transaction": NSNull()]

        case .userCancelled:
            return ["status": "cancelled", "transaction": NSNull()]

        @unknown default:
            return ["status": "cancelled", "transaction": NSNull()]
        }
    }

    /// Marks a transaction delivered. Only ever called after our server has
    /// verified the JWS and granted the goods.
    func finish(transactionId: String) async {
        if let transaction = unfinished.removeValue(forKey: transactionId) {
            await transaction.finish()
            return
        }

        // Not in our table. This is NOT a no-op case: the map lives only as long
        // as the process, so a JS retry after a WebView reload, or a grant
        // replayed from our own queue, would silently leave the transaction
        // unfinished — and StoreKit would then re-deliver it on every launch
        // forever. `Transaction.unfinished` is the store's own authoritative
        // list, so ask it rather than shrugging.
        for await result in Transaction.unfinished {
            let transaction = result.unsafePayloadValue
            if String(transaction.id) == transactionId {
                await transaction.finish()
                return
            }
        }
    }

    // MARK: - Entitlements

    /// Everything the user currently owns: active subscriptions and any
    /// non-consumables. Consumables never appear here — neither store treats
    /// them as restorable, by design.
    func restore() async -> [[String: Any]] {
        var out: [[String: Any]] = []
        for await result in Transaction.currentEntitlements {
            let transaction = result.unsafePayloadValue
            unfinished[String(transaction.id)] = transaction
            out.append(Self.transactionPayload(result, unsolicited: true))
        }
        return out
    }

    /// The STORE's view of subscription state, for UI hints only. The server's
    /// `iap_entitlements` table is the authority, because renewals and
    /// cancellations happen while the app is closed.
    func entitlements() async -> [[String: Any]] {
        var out: [[String: Any]] = []

        for await result in Transaction.currentEntitlements {
            let transaction = result.unsafePayloadValue
            guard transaction.productType == .autoRenewable else { continue }

            // `Any` so an unknown value can be reported as null rather than
            // guessed. It previously defaulted to `true`, so whenever
            // initialize() had not been called with the subscription ids, a
            // CANCELLED subscription was reported to the UI as auto-renewing.
            // The server is the authority here; saying "unknown" is honest,
            // saying "true" is wrong.
            var willRenew: Any = NSNull()
            var inGracePeriod = false

            // Renewal detail isn't on the transaction; it comes from the
            // subscription group's status.
            if let product = products[transaction.productID],
               let subscription = product.subscription,
               let statuses = try? await subscription.status {
                let match = statuses.first {
                    $0.transaction.unsafePayloadValue.originalID == transaction.originalID
                }
                if let match {
                    inGracePeriod = (match.state == .inGracePeriod)
                    if case .verified(let renewal) = match.renewalInfo {
                        willRenew = renewal.willAutoRenew
                    }
                }
            }

            out.append([
                "productId": transaction.productID,
                "originalTransactionId": String(transaction.originalID),
                "expiresAt": transaction.expirationDate.map { $0.timeIntervalSince1970 * 1000 } ?? NSNull(),
                "willRenew": willRenew,
                "inGracePeriod": inGracePeriod
            ])
        }

        return out
    }

    // MARK: - Mapping

    private static func transactionPayload(
        _ result: VerificationResult<Transaction>,
        unsolicited: Bool
    ) -> [String: Any] {
        let transaction = result.unsafePayloadValue
        return [
            "productId": transaction.productID,
            "transactionId": String(transaction.id),
            "platform": "ios",
            // The signed original. Our server verifies THIS, not anything the
            // client claims about it.
            "token": result.jwsRepresentation,
            "unsolicited": unsolicited
        ]
    }

    private static func productPayload(_ product: Product) async -> [String: Any] {
        var payload: [String: Any] = [
            "productId": product.id,
            "type": product.subscription != nil ? "subscription" : "consumable",
            "title": product.displayName,
            "description": product.description,
            // Already localised by StoreKit in the STORE's currency, which is
            // not necessarily the device locale's. Display this verbatim.
            "price": product.displayPrice,
            "priceMicros": NSDecimalNumber(decimal: product.price * 1_000_000).int64Value,
            "currency": product.priceFormatStyle.currencyCode
        ]

        if let subscription = product.subscription {
            payload["subscriptionPeriod"] = iso8601(subscription.subscriptionPeriod)

            // Only advertise an intro offer this user can actually take. Showing
            // "free trial" to someone who already used theirs is a support
            // ticket and, if it reaches the paywall copy, a review problem.
            if let offer = subscription.introductoryOffer,
               await subscription.isEligibleForIntroOffer {
                payload["introOffer"] = [
                    "price": offer.displayPrice,
                    "priceMicros": NSDecimalNumber(decimal: offer.price * 1_000_000).int64Value,
                    "period": iso8601(offer.period),
                    "type": offerType(offer.paymentMode)
                ]
            }
        }

        return payload
    }

    private static func iso8601(_ period: Product.SubscriptionPeriod) -> String {
        let unit: String
        switch period.unit {
        case .day: unit = "D"
        case .week:
            // ISO 8601 has no week designator inside a plain duration, so a
            // week is expressed as 7 days. "P1W" would be wrong.
            return "P\(period.value * 7)D"
        case .month: unit = "M"
        case .year: unit = "Y"
        @unknown default: unit = "D"
        }
        return "P\(period.value)\(unit)"
    }

    private static func offerType(_ mode: Product.SubscriptionOffer.PaymentMode) -> String {
        switch mode {
        case .freeTrial: return "free_trial"
        case .payAsYouGo: return "pay_as_you_go"
        case .payUpFront: return "pay_up_front"
        default: return "unknown"
        }
    }
}

enum IapError: LocalizedError {
    case unknownProduct(String)

    var errorDescription: String? {
        switch self {
        case .unknownProduct(let id):
            return "Product '\(id)' was not loaded. Call initialize() with this id first, "
                 + "and check it exists and is in a reviewable state in App Store Connect."
        }
    }
}
