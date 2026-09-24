import Capacitor
import Foundation

/// Capacitor bridge for StoreKit 2.
///
/// Deliberately thin: it marshals between the JS bridge and `StoreKitService`
/// and does no purchase logic of its own. `jsName` is what the web app reaches
/// as `window.Capacitor.Plugins.SpruikIap`.
@objc(SpruikIapPlugin)
public class SpruikIapPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "SpruikIapPlugin"
    public let jsName = "SpruikIap"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "initialize", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getProducts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getEntitlements", returnType: CAPPluginReturnPromise)
    ]

    private let service = StoreKitService()

    /// Capacitor calls this once, at plugin instantiation during app launch.
    ///
    /// Starting the transaction listener HERE rather than in `initialize()` is
    /// the point: StoreKit flushes transactions queued while the app was closed
    /// as soon as something subscribes, so a listener that only starts when the
    /// credits screen opens would miss an Ask-to-Buy approval or a purchase
    /// that was interrupted mid-flight.
    override public func load() {
        Task { [weak self] in
            guard let self else { return }
            await self.service.setTransactionHandler { [weak self] payload in
                self?.notifyListeners("transactionUpdated", data: payload, retainUntilConsumed: true)
            }
            await self.service.startListening()
        }
    }

    deinit {
        let service = self.service
        Task { await service.stopListening() }
    }

    // MARK: - Bridged methods

    @objc func initialize(_ call: CAPPluginCall) {
        let productIds = call.getArray("productIds", String.self) ?? []
        Task { [service = self.service] in
            do {
                let available = try await service.initialize(productIds: productIds)
                call.resolve(["available": available])
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    @objc func getProducts(_ call: CAPPluginCall) {
        Task { [service = self.service] in
            call.resolve(["products": await service.productPayloads()])
        }
    }

    @objc func purchase(_ call: CAPPluginCall) {
        guard let productId = call.getString("productId") else {
            call.reject("productId is required")
            return
        }

        // Optional: ties the purchase to our own account id. Apple echoes it
        // back in the signed transaction and in every server notification, so a
        // refund arriving days later can be attributed without relying on our
        // verify call having succeeded at purchase time. Must be a UUID; a
        // malformed one is ignored rather than failing the purchase, because
        // losing attribution is far better than losing the sale.
        let appAccountToken = call.getString("appAccountToken").flatMap { UUID(uuidString: $0) }

        Task { [service = self.service] in
            do {
                let result = try await service.purchase(
                    productId: productId,
                    appAccountToken: appAccountToken
                )
                call.resolve(result)
            } catch {
                call.reject(error.localizedDescription, nil, error)
            }
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        guard let transactionId = call.getString("transactionId") else {
            call.reject("transactionId is required")
            return
        }
        Task { [service = self.service] in
            await service.finish(transactionId: transactionId)
            call.resolve()
        }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task { [service = self.service] in
            call.resolve(["transactions": await service.restore()])
        }
    }

    @objc func getEntitlements(_ call: CAPPluginCall) {
        Task { [service = self.service] in
            call.resolve(["entitlements": await service.entitlements()])
        }
    }
}
