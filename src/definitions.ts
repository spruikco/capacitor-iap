/**
 * One in-app-purchase interface over two very different stores.
 *
 * The shapes below are deliberately the INTERSECTION of StoreKit 2 and Play
 * Billing, with the platform differences pushed down into the native code
 * rather than leaked to callers. Where a difference genuinely cannot be hidden
 * (what the server needs in order to verify a purchase) it is named honestly
 * rather than papered over — see `IapTransaction.token`.
 *
 * ── The money rule ──────────────────────────────────────────────────────────
 * The client is never trusted. A purchase is only "real" once our server has
 * verified it with Apple or Google and granted the goods. Concretely:
 *
 *     purchase() resolves  ->  POST the token to our server  ->  server
 *     verifies with the store  ->  server grants  ->  200  ->  finish()
 *
 * `finish()` is what tells the store "we have delivered this". Until it is
 * called, BOTH stores keep re-delivering the transaction (via the
 * `transactionUpdated` listener on the next launch), which is exactly the
 * behaviour we want: if verification fails or the network drops, the player
 * has still paid and the purchase will be retried until it lands. Calling
 * finish() before the server confirms would take payment and deliver nothing.
 *
 * ⚠️ ANDROID HAS A DEADLINE. Google auto-refunds any purchase not acknowledged
 * within three days. iOS has no equivalent timer. So "retry forever" is only
 * safe on iOS; on Android the reconciliation job has to close the gap well
 * inside 72 hours.
 */

/** Consumables are bought repeatedly; subscriptions renew until cancelled. */
export type IapProductType = 'consumable' | 'subscription';

export interface IapProduct {
  /** Store product identifier, e.g. `com.example.credits.standard`. */
  productId: string;
  type: IapProductType;
  title: string;
  description: string;
  /**
   * Price already formatted in the STORE's locale and currency ("$4.99",
   * "€4,99", "¥600"). Always display this and never our own hardcoded price:
   * Apple and Google set regional pricing, so our `priceCents` is only correct
   * in the base region. Showing a price that differs from the one on the
   * payment sheet is also a review rejection.
   */
  price: string;
  /** Price in micro-units of `currency` (4.99 => 4990000). For analytics. */
  priceMicros: number;
  /** ISO 4217, e.g. "AUD". */
  currency: string;
  /** ISO 8601 duration ("P1M", "P1Y"). Subscriptions only. */
  subscriptionPeriod?: string;
  /** Present when this user is eligible for an intro/free-trial offer. */
  introOffer?: {
    price: string;
    priceMicros: number;
    period: string;
    /** `free_trial` on both stores; `pay_up_front`/`pay_as_you_go` on iOS. */
    type: string;
  };
}

export interface IapTransaction {
  productId: string;
  /**
   * Store transaction identifier. Used as the ledger idempotency key, so the
   * same transaction can never grant twice however many times it is delivered.
   */
  transactionId: string;
  platform: 'ios' | 'android';
  /**
   * What the server verifies. THIS IS NOT THE SAME OBJECT ON BOTH PLATFORMS:
   *
   *   iOS      the StoreKit 2 `jwsRepresentation` — a signed JWS the server
   *            verifies offline against Apple's root certificates. No network
   *            call to Apple, no shared secret.
   *   Android  the Play `purchaseToken` — an opaque handle the server must
   *            exchange with the Play Developer API to learn anything.
   *
   * Both are opaque to the client and neither is trusted here.
   */
  token: string;
  /** Android only: required by the Play Developer API alongside the token. */
  packageName?: string;
  /**
   * True when the transaction arrived from the store rather than from a
   * purchase() this session: a subscription renewal, an Ask-to-Buy approval a
   * parent granted later, or a purchase interrupted before we finished it.
   * These arrive via the `transactionUpdated` listener and must be verified
   * and finished exactly like a fresh one.
   */
  unsolicited: boolean;
}

export type IapPurchaseStatus =
  /** Paid and ready to verify. `transaction` is present. */
  | 'purchased'
  /**
   * Awaiting someone else: Ask-to-Buy needing a parent, or an Indian mandate /
   * slow payment method on Play. `transaction` is null. Do NOT show an error —
   * it may complete minutes or days later and arrive via `transactionUpdated`.
   */
  | 'pending'
  /** The user dismissed the sheet. Not an error; say nothing. */
  | 'cancelled';

export interface IapPurchaseResult {
  status: IapPurchaseStatus;
  transaction: IapTransaction | null;
}

/**
 * A subscription's current state, as the STORE sees it. This is only ever a
 * hint for the UI: the server's `iap_entitlements` table is the authority,
 * because renewals and cancellations happen while the app is closed and the
 * client cannot be relied upon to have seen them.
 */
export interface IapEntitlement {
  productId: string;
  /** Groups the renewals of one subscription together across its lifetime. */
  originalTransactionId: string;
  /** Epoch ms when access lapses. */
  expiresAt: number | null;
  /**
   * False once the user turns off auto-renew; access runs to `expiresAt`.
   * `null` when the store could not tell us — never assume `true` from a null,
   * because "unknown" and "renewing" are very different things to show a user.
   */
  willRenew: boolean | null;
  /** True while the store is retrying a failed payment (grace period). */
  inGracePeriod: boolean;
}

export interface SpruikIapPlugin {
  /**
   * Connects to the store and loads product metadata. Safe to call more than
   * once. Resolves `available: false` when the device cannot purchase at all
   * (parental restrictions, no Play Services, a store outage) — in that case
   * hide the buy UI rather than showing buttons that will fail.
   */
  initialize(options: { productIds: string[] }): Promise<{ available: boolean }>;

  /** Products loaded by `initialize`, with store-localised prices. */
  getProducts(): Promise<{ products: IapProduct[] }>;

  /**
   * Presents the store's payment sheet. Never rejects for a user cancel.
   *
   * `appAccountToken` stamps your own account id onto the transaction, so a
   * refund or a voided purchase learned about days later can be attributed to
   * the right account even if the original verify call never reached your
   * server. Both stores support this, with different rules:
   *
   *   iOS      `Product.PurchaseOption.appAccountToken`. MUST be a UUID —
   *            anything else is ignored rather than failing the purchase,
   *            because losing attribution beats losing the sale. Echoed back
   *            in the signed payload and in every server notification.
   *   Android  `setObfuscatedAccountId`. Any string, but Google asks that it
   *            not be the raw account id, so pass something opaque. Comes back
   *            on the Purchase and in the Play Developer API response.
   *
   * Passing the same opaque per-user value on both platforms is the simplest
   * thing that satisfies both.
   */
  purchase(options: {
    productId: string;
    appAccountToken?: string;
  }): Promise<IapPurchaseResult>;

  /**
   * Tell the store the goods are delivered. ONLY call after our server has
   * verified and granted.
   *
   *   iOS      `Transaction.finish()`.
   *   Android  `consumeAsync` when `consume` is true (consumables, so the
   *            product can be bought again), otherwise `acknowledgePurchase`
   *            (subscriptions). Getting this backwards means either a
   *            subscription that can never be re-bought or a consumable that
   *            can only be bought once, so the caller passes it explicitly.
   */
  finish(options: { transactionId: string; consume: boolean }): Promise<void>;

  /**
   * Re-delivers everything the user still owns. Consumables are NOT restorable
   * on either store by design, so this is for subscriptions. Apple requires a
   * visible restore control for non-consumables; our credit packs are
   * consumables, so the button is only needed once a subscription ships.
   */
  restore(): Promise<{ transactions: IapTransaction[] }>;

  /** The store's view of active subscriptions. See `IapEntitlement`. */
  getEntitlements(): Promise<{ entitlements: IapEntitlement[] }>;

  /**
   * Transactions arriving outside a purchase() call. Attach this BEFORE
   * calling initialize(): both stores flush queued transactions on connect,
   * and a listener attached afterwards misses them.
   */
  addListener(
    eventName: 'transactionUpdated',
    listener: (transaction: IapTransaction) => void,
  ): Promise<{ remove: () => Promise<void> }>;

  removeAllListeners(): Promise<void>;
}
