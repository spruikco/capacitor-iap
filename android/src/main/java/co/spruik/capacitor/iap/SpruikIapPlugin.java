package co.spruik.capacitor.iap;

import android.app.Activity;

import androidx.annotation.NonNull;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Play Billing behind the same JS interface as the iOS StoreKit 2 plugin.
 *
 * ── Two things about Play that iOS does not have ────────────────────────────
 *
 * 1. THE PURCHASE DOES NOT COME BACK FROM THE CALL. `launchBillingFlow` only
 *    opens the sheet; the result arrives later on {@link PurchasesUpdatedListener}.
 *    So `purchase()` parks its {@link PluginCall} and the listener resolves it.
 *
 * 2. THERE IS A DEADLINE. Google automatically refunds any purchase that is not
 *    acknowledged or consumed within three days. iOS will happily re-deliver an
 *    unfinished transaction forever; Play will quietly hand the money back. Our
 *    server-side reconciliation job has to close that gap well inside 72 hours,
 *    because "the player paid, we never granted, Google refunded a week later"
 *    is invisible from inside the app.
 */
@CapacitorPlugin(name = "SpruikIap")
public class SpruikIapPlugin extends Plugin implements PurchasesUpdatedListener {

    private BillingClient billingClient;

    /** Product metadata from the last initialize(), keyed by product id. */
    private final Map<String, ProductDetails> products = new ConcurrentHashMap<>();

    /**
     * Subscription offer tokens, keyed by product id. Play requires the token
     * of a specific offer to start a subscription purchase; one-time products
     * generally do not need one.
     */
    private final Map<String, String> offerTokens = new ConcurrentHashMap<>();

    /**
     * Purchases delivered but not yet granted by our server, keyed by purchase
     * token. See the class comment: these must be resolved inside 72 hours.
     */
    private final Map<String, Purchase> unfinished = new ConcurrentHashMap<>();

    /**
     * The in-flight purchase() call, parked until onPurchasesUpdated fires.
     *
     * One slot is enough because the billing sheet is modal. It is an
     * AtomicReference rather than a plain field because Play delivers callbacks
     * off the calling thread, so "read it, then null it" must be a single
     * indivisible step — resolving the same PluginCall twice throws at runtime,
     * and that would surface as a random crash during checkout rather than
     * anything reproducible.
     */
    private final AtomicReference<PluginCall> pendingPurchase = new AtomicReference<>();

    // ── Lifecycle ───────────────────────────────────────────────────────────

    @Override
    public void load() {
        billingClient = BillingClient
            .newBuilder(getContext())
            .setListener(this)
            // Required since PBL 6 for one-time products. Without it, pending
            // purchases (slow payment methods, which are common in India and
            // Brazil) are never delivered at all.
            .enablePendingPurchases(
                PendingPurchasesParams.newBuilder().enableOneTimeProducts().build()
            )
            // PBL 9: the client reconnects itself after Play Services restarts
            // or the service is killed under memory pressure. Without it every
            // call after a disconnect fails until we manually reconnect.
            .enableAutoServiceReconnection()
            .build();

        billingClient.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(@NonNull BillingResult result) {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    // Sweep up anything bought while we were not listening: a
                    // purchase completed after the app was killed, or a pending
                    // payment that cleared overnight.
                    queryOutstandingPurchases();
                }
            }

            @Override
            public void onBillingServiceDisconnected() {
                // Handled by enableAutoServiceReconnection().
            }
        });
    }

    /**
     * Play delivers a purchase completed outside the app (a pending payment
     * clearing, or a purchase made on another device) only when asked. Checking
     * on resume is what stops those from sitting unacknowledged until Google
     * refunds them.
     */
    @Override
    protected void handleOnResume() {
        if (billingClient != null && billingClient.isReady()) {
            queryOutstandingPurchases();
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (billingClient != null) {
            billingClient.endConnection();
        }
    }

    // ── initialize ──────────────────────────────────────────────────────────

    @PluginMethod
    public void initialize(PluginCall call) {
        JSArray idsArray = call.getArray("productIds");
        final List<String> ids = new ArrayList<>();
        if (idsArray != null) {
            try {
                ids.addAll(idsArray.toList());
            } catch (Exception ignored) {
                // A malformed list is treated as empty: initialize still
                // reports availability, the buy UI just has nothing to show.
            }
        }

        if (billingClient == null) {
            call.resolve(new JSObject().put("available", false).put("reason", "no-client"));
            return;
        }
        if (!billingClient.isReady()) {
            // The load()-time connection may simply not have settled yet —
            // reaching this screen fast enough made initialize() report
            // unavailable with no retry, and the store rendered permanently
            // empty (2 Sep). Connect (or piggyback on the pending connect)
            // and finish initialize from the callback instead.
            final PluginCall pending = call;
            billingClient.startConnection(new BillingClientStateListener() {
                @Override
                public void onBillingSetupFinished(@NonNull BillingResult result) {
                    if (result.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                        queryOutstandingPurchases();
                        finishInitialize(pending, ids);
                    } else {
                        // Surface WHY Play refused — the old plugin swallowed
                        // the code and made production failures undiagnosable.
                        pending.resolve(new JSObject()
                            .put("available", false)
                            .put("reason", "setup-failed")
                            .put("responseCode", result.getResponseCode())
                            .put("debugMessage", result.getDebugMessage()));
                    }
                }

                @Override
                public void onBillingServiceDisconnected() {
                    // Auto-reconnect handles the transport; the pending call
                    // resolves via onBillingSetupFinished when it lands.
                }
            });
            return;
        }
        finishInitialize(call, ids);
    }

    /** The body of initialize() once a billing connection exists. */
    private void finishInitialize(PluginCall call, List<String> ids) {

        if (ids.isEmpty()) {
            call.resolve(new JSObject().put("available", true));
            return;
        }

        products.clear();
        offerTokens.clear();

        // The caller does not tell us which ids are consumables and which are
        // subscriptions, so ask for both and keep whatever Play recognises.
        // Ids that do not exist in a given type simply come back unfetched.
        final AtomicInteger remaining = new AtomicInteger(2);
        final Runnable done = () -> {
            if (remaining.decrementAndGet() == 0) {
                call.resolve(new JSObject().put("available", !products.isEmpty()));
            }
        };

        queryProductType(ids, BillingClient.ProductType.INAPP, done);
        queryProductType(ids, BillingClient.ProductType.SUBS, done);
    }

    private void queryProductType(List<String> ids, String type, Runnable done) {
        List<QueryProductDetailsParams.Product> query = new ArrayList<>();
        for (String id : ids) {
            query.add(
                QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id)
                    .setProductType(type)
                    .build()
            );
        }

        billingClient.queryProductDetailsAsync(
            QueryProductDetailsParams.newBuilder().setProductList(query).build(),
            (BillingResult result, com.android.billingclient.api.QueryProductDetailsResult details) -> {
                if (result.getResponseCode() == BillingClient.BillingResponseCode.OK
                        && details != null) {
                    for (ProductDetails product : details.getProductDetailsList()) {
                        products.put(product.getProductId(), product);
                        String token = firstOfferToken(product);
                        if (token != null) {
                            offerTokens.put(product.getProductId(), token);
                        }
                    }
                }
                done.run();
            }
        );
    }

    // ── getProducts ─────────────────────────────────────────────────────────

    @PluginMethod
    public void getProducts(PluginCall call) {
        JSArray out = new JSArray();
        for (ProductDetails product : products.values()) {
            JSObject payload = productPayload(product);
            if (payload != null) {
                out.put(payload);
            }
        }
        call.resolve(new JSObject().put("products", out));
    }

    // ── purchase ────────────────────────────────────────────────────────────

    @PluginMethod
    public void purchase(PluginCall call) {
        String productId = call.getString("productId");
        if (productId == null) {
            call.reject("productId is required");
            return;
        }

        ProductDetails product = products.get(productId);
        if (product == null) {
            call.reject(
                "Product '" + productId + "' was not loaded. Call initialize() with this id "
                    + "first, and check it is active in the Play Console."
            );
            return;
        }

        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No foreground activity to present the billing flow.");
            return;
        }

        BillingFlowParams.ProductDetailsParams.Builder productParams =
            BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product);

        // Subscriptions must name a specific offer. One-time products normally
        // must not, so only set it when we actually resolved one.
        String offerToken = offerTokens.get(productId);
        if (offerToken != null) {
            productParams.setOfferToken(offerToken);
        }

        BillingFlowParams.Builder flow = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(Collections.singletonList(productParams.build()));

        // Play's equivalent of Apple's appAccountToken. It comes back on the
        // purchase and in the Play Developer API response, so a refund or a
        // voided purchase learned about later can be attributed to the right
        // account without depending on our verify call having succeeded.
        // Google asks that this not be the raw account id, so callers pass an
        // opaque/hashed value.
        String accountId = call.getString("appAccountToken");
        if (accountId != null && !accountId.isEmpty()) {
            flow.setObfuscatedAccountId(accountId);
        }

        // Park the call: the result arrives on onPurchasesUpdated, not here.
        call.setKeepAlive(true);
        pendingPurchase.set(call);

        activity.runOnUiThread(() -> {
            BillingResult result = billingClient.launchBillingFlow(activity, flow.build());
            if (result.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                failPending(result.getResponseCode());
            }
        });
    }

    @Override
    public void onPurchasesUpdated(@NonNull BillingResult result, List<Purchase> purchases) {
        int code = result.getResponseCode();

        if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
            for (Purchase purchase : purchases) {
                handlePurchase(purchase);
            }
            return;
        }

        if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            // A consumable that was bought but never consumed, almost always
            // because a previous grant failed. Not an error state: re-deliver
            // it so it can be verified and consumed, which also unblocks
            // buying that product again.
            queryOutstandingPurchases();
            resolvePending("pending", null);
            return;
        }

        failPending(code);
    }

    /**
     * A user cancel resolves 'cancelled'; anything else REJECTS.
     *
     * Collapsing every failure into 'cancelled' would be much tidier and much
     * worse: DEVELOPER_ERROR (wrong product config), BILLING_UNAVAILABLE (no
     * Play account) and SERVICE_UNAVAILABLE would all read as "the user changed
     * their mind", so a store misconfiguration would look like weak conversion
     * and could sit unnoticed indefinitely.
     */
    private void failPending(int code) {
        if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            resolvePending("cancelled", null);
            return;
        }

        PluginCall call = pendingPurchase.getAndSet(null);
        if (call != null) {
            call.reject(billingErrorMessage(code), String.valueOf(code));
        }
    }

    private String billingErrorMessage(int code) {
        if (code == BillingClient.BillingResponseCode.BILLING_UNAVAILABLE) {
            return "Google Play billing is unavailable on this device or account.";
        }
        if (code == BillingClient.BillingResponseCode.ITEM_UNAVAILABLE) {
            return "That product is not available for purchase in this account's country.";
        }
        if (code == BillingClient.BillingResponseCode.DEVELOPER_ERROR) {
            return "Play rejected the purchase request as misconfigured (DEVELOPER_ERROR). "
                 + "Usually the product id, its active state in the Play Console, or app signing.";
        }
        if (code == BillingClient.BillingResponseCode.SERVICE_UNAVAILABLE
                || code == BillingClient.BillingResponseCode.SERVICE_DISCONNECTED) {
            return "Google Play is temporarily unreachable. Try again shortly.";
        }
        if (code == BillingClient.BillingResponseCode.NETWORK_ERROR) {
            return "No connection to Google Play.";
        }
        return "Google Play returned billing response code " + code + ".";
    }

    private void handlePurchase(Purchase purchase) {
        // PENDING means the user chose a slow payment method and has not paid
        // yet. There is nothing to verify and nothing to grant; it will arrive
        // again as PURCHASED if and when it clears.
        if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) {
            resolvePending("pending", null);
            return;
        }

        unfinished.put(purchase.getPurchaseToken(), purchase);

        boolean solicited = pendingPurchase.get() != null;
        JSObject payload = transactionPayload(purchase, !solicited);

        if (solicited) {
            resolvePending("purchased", payload);
        } else {
            notifyListeners("transactionUpdated", payload);
        }
    }

    private void resolvePending(String status, JSObject transaction) {
        // getAndSet is the whole point: whichever thread wins takes the call,
        // the loser sees null and routes the transaction to the listener instead.
        PluginCall call = pendingPurchase.getAndSet(null);

        if (call == null) {
            // Nothing waiting: this came from the store on its own, so push it
            // to JS as an unsolicited transaction instead of dropping it.
            if (transaction != null) {
                notifyListeners("transactionUpdated", transaction);
            }
            return;
        }

        JSObject out = new JSObject().put("status", status);
        out.put("transaction", transaction == null ? JSObject.NULL : transaction);
        call.resolve(out);
    }

    // ── finish ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void finish(PluginCall call) {
        String transactionId = call.getString("transactionId");
        if (transactionId == null) {
            call.reject("transactionId is required");
            return;
        }

        Purchase purchase = unfinished.get(transactionId);
        if (purchase == null) {
            // Already finished, or from a previous process. Nothing to do, and
            // definitely not an error worth failing a grant over.
            call.resolve();
            return;
        }

        // consume = "this can be bought again" (credit packs).
        // acknowledge = "delivered, keep it" (subscriptions).
        // Getting these backwards gives either a consumable that can only ever
        // be bought once, or a subscription Google refunds after three days.
        boolean consume = Boolean.TRUE.equals(call.getBoolean("consume", false));

        if (consume) {
            billingClient.consumeAsync(
                ConsumeParams.newBuilder().setPurchaseToken(purchase.getPurchaseToken()).build(),
                (BillingResult result, String token) -> {
                    unfinished.remove(transactionId);
                    call.resolve();
                }
            );
            return;
        }

        if (purchase.isAcknowledged()) {
            unfinished.remove(transactionId);
            call.resolve();
            return;
        }

        billingClient.acknowledgePurchase(
            AcknowledgePurchaseParams.newBuilder()
                .setPurchaseToken(purchase.getPurchaseToken())
                .build(),
            (BillingResult result) -> {
                unfinished.remove(transactionId);
                call.resolve();
            }
        );
    }

    // ── restore / entitlements ──────────────────────────────────────────────

    @PluginMethod
    public void restore(PluginCall call) {
        JSArray out = new JSArray();
        final AtomicInteger remaining = new AtomicInteger(2);
        final Runnable done = () -> {
            if (remaining.decrementAndGet() == 0) {
                call.resolve(new JSObject().put("transactions", out));
            }
        };

        for (String type : new String[] { BillingClient.ProductType.INAPP, BillingClient.ProductType.SUBS }) {
            billingClient.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(type).build(),
                (BillingResult result, List<Purchase> purchases) -> {
                    if (purchases != null) {
                        for (Purchase purchase : purchases) {
                            if (purchase.getPurchaseState() == Purchase.PurchaseState.PURCHASED) {
                                unfinished.put(purchase.getPurchaseToken(), purchase);
                                out.put(transactionPayload(purchase, true));
                            }
                        }
                    }
                    done.run();
                }
            );
        }
    }

    @PluginMethod
    public void getEntitlements(PluginCall call) {
        billingClient.queryPurchasesAsync(
            QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build(),
            (BillingResult result, List<Purchase> purchases) -> {
                JSArray out = new JSArray();
                if (purchases != null) {
                    for (Purchase purchase : purchases) {
                        for (String productId : purchase.getProducts()) {
                            JSObject entitlement = new JSObject();
                            entitlement.put("productId", productId);
                            entitlement.put("originalTransactionId", purchase.getPurchaseToken());
                            // Play's client-side Purchase carries no expiry —
                            // only the Play Developer API knows it. The server's
                            // iap_entitlements table is the authority; this is a
                            // UI hint, so null is honest rather than guessed.
                            entitlement.put("expiresAt", JSObject.NULL);
                            entitlement.put("willRenew", purchase.isAutoRenewing());
                            // Grace period is likewise server-side only on Play.
                            entitlement.put("inGracePeriod", false);
                            out.put(entitlement);
                        }
                    }
                }
                call.resolve(new JSObject().put("entitlements", out));
            }
        );
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    private void queryOutstandingPurchases() {
        for (String type : new String[] { BillingClient.ProductType.INAPP, BillingClient.ProductType.SUBS }) {
            billingClient.queryPurchasesAsync(
                QueryPurchasesParams.newBuilder().setProductType(type).build(),
                (BillingResult result, List<Purchase> purchases) -> {
                    if (purchases == null) return;
                    for (Purchase purchase : purchases) {
                        if (purchase.getPurchaseState() != Purchase.PurchaseState.PURCHASED) {
                            continue;
                        }
                        // Anything already acknowledged AND not a consumable we
                        // still owe is not our problem; re-emitting is harmless
                        // because the server grant is idempotent on the token.
                        unfinished.put(purchase.getPurchaseToken(), purchase);
                        notifyListeners("transactionUpdated", transactionPayload(purchase, true));
                    }
                }
            );
        }
    }

    private JSObject transactionPayload(Purchase purchase, boolean unsolicited) {
        JSObject out = new JSObject();
        List<String> ids = purchase.getProducts();
        out.put("productId", ids.isEmpty() ? "" : ids.get(0));
        // The purchase token doubles as the transaction id on Android: it is
        // the stable unique handle, and unlike orderId it is never null (order
        // ids are absent for pending and for some test purchases). Using it for
        // both keeps finish() a direct lookup and gives the ledger a reliable
        // idempotency key.
        out.put("transactionId", purchase.getPurchaseToken());
        out.put("platform", "android");
        out.put("token", purchase.getPurchaseToken());
        out.put("packageName", purchase.getPackageName());
        out.put("unsolicited", unsolicited);
        return out;
    }

    private JSObject productPayload(ProductDetails product) {
        JSObject out = new JSObject();
        out.put("productId", product.getProductId());
        out.put("title", product.getTitle());
        out.put("description", product.getDescription());

        boolean isSubscription = BillingClient.ProductType.SUBS.equals(product.getProductType());
        out.put("type", isSubscription ? "subscription" : "consumable");

        if (!isSubscription) {
            ProductDetails.OneTimePurchaseOfferDetails offer = product.getOneTimePurchaseOfferDetails();
            if (offer == null) {
                // PBL 9 can express one-time products through an offer list
                // instead of the single legacy field.
                List<ProductDetails.OneTimePurchaseOfferDetails> list =
                    product.getOneTimePurchaseOfferDetailsList();
                if (list != null && !list.isEmpty()) {
                    offer = list.get(0);
                }
            }
            if (offer == null) return null;

            out.put("price", offer.getFormattedPrice());
            out.put("priceMicros", offer.getPriceAmountMicros());
            out.put("currency", offer.getPriceCurrencyCode());
            return out;
        }

        List<ProductDetails.SubscriptionOfferDetails> offers = product.getSubscriptionOfferDetails();
        if (offers == null || offers.isEmpty()) return null;

        ProductDetails.SubscriptionOfferDetails offer = offers.get(0);
        List<ProductDetails.PricingPhase> phases = offer.getPricingPhases().getPricingPhaseList();
        if (phases.isEmpty()) return null;

        // The LAST phase is the ongoing price; earlier phases are the intro
        // offer or free trial. Reading phase 0 as "the price" is the classic
        // bug here — it shows "$0.00/month" for anything with a trial.
        ProductDetails.PricingPhase base = phases.get(phases.size() - 1);
        out.put("price", base.getFormattedPrice());
        out.put("priceMicros", base.getPriceAmountMicros());
        out.put("currency", base.getPriceCurrencyCode());
        // Play already gives ISO 8601 ("P1M"), matching what iOS builds by hand.
        out.put("subscriptionPeriod", base.getBillingPeriod());

        if (phases.size() > 1) {
            ProductDetails.PricingPhase intro = phases.get(0);
            JSObject introOffer = new JSObject();
            introOffer.put("price", intro.getFormattedPrice());
            introOffer.put("priceMicros", intro.getPriceAmountMicros());
            introOffer.put("period", intro.getBillingPeriod());
            introOffer.put("type", intro.getPriceAmountMicros() == 0 ? "free_trial" : "pay_as_you_go");
            out.put("introOffer", introOffer);
        }

        return out;
    }

    private String firstOfferToken(ProductDetails product) {
        List<ProductDetails.SubscriptionOfferDetails> offers = product.getSubscriptionOfferDetails();
        if (offers == null || offers.isEmpty()) return null;
        return offers.get(0).getOfferToken();
    }

}
