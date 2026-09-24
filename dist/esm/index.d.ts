// Public type contract. Kept in step with src/definitions.ts by hand — see
// README.md for why this package commits its dist rather than building in CI.
// The prose reasoning lives in src/definitions.ts; this file is the shipped
// surface, trimmed to the declarations.

export type IapProductType = 'consumable' | 'subscription';

export interface IapProduct {
  productId: string;
  type: IapProductType;
  title: string;
  description: string;
  /** Store-localised display price. Always render this, never our own. */
  price: string;
  priceMicros: number;
  currency: string;
  /** ISO 8601 duration. Subscriptions only. */
  subscriptionPeriod?: string;
  introOffer?: {
    price: string;
    priceMicros: number;
    period: string;
    type: string;
  };
}

export interface IapTransaction {
  productId: string;
  transactionId: string;
  platform: 'ios' | 'android';
  /** iOS: StoreKit 2 JWS. Android: Play purchaseToken. Verified server-side. */
  token: string;
  /** Android only. */
  packageName?: string;
  /** Arrived from the store rather than a purchase() this session. */
  unsolicited: boolean;
}

export type IapPurchaseStatus = 'purchased' | 'pending' | 'cancelled';

export interface IapPurchaseResult {
  status: IapPurchaseStatus;
  transaction: IapTransaction | null;
}

export interface IapEntitlement {
  productId: string;
  originalTransactionId: string;
  expiresAt: number | null;
  /** `null` when the store could not tell us. Do not treat null as true. */
  willRenew: boolean | null;
  inGracePeriod: boolean;
}

export interface SpruikIapPlugin {
  initialize(options: { productIds: string[] }): Promise<{ available: boolean }>;
  getProducts(): Promise<{ products: IapProduct[] }>;
  /** `appAccountToken` (iOS, UUID) ties the purchase to your account id for refund attribution. */
  purchase(options: {
    productId: string;
    appAccountToken?: string;
  }): Promise<IapPurchaseResult>;
  /** ONLY after the server has verified and granted. */
  finish(options: { transactionId: string; consume: boolean }): Promise<void>;
  restore(): Promise<{ transactions: IapTransaction[] }>;
  getEntitlements(): Promise<{ entitlements: IapEntitlement[] }>;
  /** Attach BEFORE initialize() — both stores flush queued transactions on connect. */
  addListener(
    eventName: 'transactionUpdated',
    listener: (transaction: IapTransaction) => void,
  ): Promise<{ remove: () => Promise<void> }>;
  removeAllListeners(): Promise<void>;
}

export declare const SpruikIap: SpruikIapPlugin;
