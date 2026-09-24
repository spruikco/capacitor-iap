import { WebPlugin } from '@capacitor/core';

import type {
  IapEntitlement,
  IapProduct,
  IapPurchaseResult,
  IapTransaction,
  SpruikIapPlugin,
} from './definitions';

/**
 * There is no in-app purchase in a browser, and there must not be a fake one.
 *
 * `initialize` reports `available: false` so callers hide the buy UI and fall
 * back to the web payment rail (Stripe, say). Every other
 * method returns empty rather than throwing, so a caller that ignores
 * `available` degrades quietly instead of crashing the page.
 *
 * `purchase` is the exception: it rejects. Silently resolving 'cancelled'
 * would let a bug where the wrong rail is chosen in a browser look like the
 * user changed their mind, and that is the kind of bug that hides for months.
 */
export class SpruikIapWeb extends WebPlugin implements SpruikIapPlugin {
  async initialize(): Promise<{ available: boolean }> {
    return { available: false };
  }

  async getProducts(): Promise<{ products: IapProduct[] }> {
    return { products: [] };
  }

  async purchase(): Promise<IapPurchaseResult> {
    throw this.unavailable(
      'In-app purchase is only available in the native app. Use the web payment rail in a browser.',
    );
  }

  async finish(): Promise<void> {
    return;
  }

  async restore(): Promise<{ transactions: IapTransaction[] }> {
    return { transactions: [] };
  }

  async getEntitlements(): Promise<{ entitlements: IapEntitlement[] }> {
    return { entitlements: [] };
  }
}
