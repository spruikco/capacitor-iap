// EXAMPLE, not a drop-in. Lifted from a production Next.js app (App Router,
// drizzle + postgres, a credits ledger). Imports from '@/lib/...' are that
// app's own auth, database and ledger; replace them with yours. The shape of
// the flow and the comments are the part worth keeping.

/**
 * In-app purchase client for the native shell.
 *
 * The web app has NO plugin dependency. @spruik/capacitor-iap is installed in
 * the SHELL (mobile/package.json) and, in remote-URL mode, its native side is
 * reachable at `window.Capacitor.Plugins.SpruikIap` — the same way
 * components/native/push-registration.tsx reaches FirebaseMessaging. Everything
 * here feature-detects and no-ops in a plain browser, so /credits can call it
 * unconditionally.
 *
 * ── The money rule ──────────────────────────────────────────────────────────
 *   purchase() -> POST the token to /api/mobile/iap/verify -> server verifies
 *   with Apple/Google and grants -> 200 -> finish() the transaction.
 *
 * finish() ONLY after a 200. Until it is called, both stores keep re-delivering
 * the transaction, so a verification hiccup means a retry rather than a player
 * who paid and got nothing. Finishing early is the one mistake here that
 * silently takes money and delivers nothing.
 *
 * ⚠️ Android has a 72-hour deadline: Google auto-refunds anything not consumed
 * or acknowledged in that window. "Retry forever" is only safe on iOS.
 */

import { getNativePlatform, isNativeApp } from '@/lib/native-app';

export interface IapProduct {
  productId: string;
  packId: string;
  title: string;
  /** Store-localised display price ("$7.99", "€6,99"), straight from the store. */
  price: string;
  credits: number;
  blurb: string;
  featured: boolean;
}

interface NativeTransaction {
  productId: string;
  transactionId: string;
  platform: 'ios' | 'android';
  token: string;
  packageName?: string;
  unsolicited: boolean;
}

interface NativeProduct {
  productId: string;
  type: string;
  title: string;
  description: string;
  price: string;
  priceMicros: number;
  currency: string;
}

interface SpruikIapBridge {
  initialize(options: { productIds: string[] }): Promise<{ available: boolean; reason?: string; responseCode?: number; debugMessage?: string }>;
  getProducts(): Promise<{ products: NativeProduct[] }>;
  purchase(options: {
    productId: string;
    appAccountToken?: string;
  }): Promise<{
    status: 'purchased' | 'pending' | 'cancelled';
    transaction: NativeTransaction | null;
  }>;
  finish(options: { transactionId: string; consume: boolean }): Promise<void>;
  addListener(
    event: 'transactionUpdated',
    cb: (t: NativeTransaction) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

function bridge(): SpruikIapBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { Capacitor?: { Plugins?: { SpruikIap?: SpruikIapBridge } } })
    .Capacitor?.Plugins?.SpruikIap;
}

/** True when in-app purchase is the rail to use. Web falls back to Stripe. */
export function isIapAvailable(): boolean {
  return isNativeApp() && !!bridge();
}

export interface VerifyResult {
  success: boolean;
  creditsGranted: number;
  balance: number | null;
  alreadyProcessed: boolean;
  /** Consumables consume; subscriptions acknowledge. The server decides. */
  consume: boolean;
}

/**
 * Sends a transaction to our server for verification and granting.
 *
 * Returns null when the failure is TRANSIENT (our server down, network gone, a
 * Google outage). The caller must NOT finish the transaction in that case —
 * leaving it unfinished is precisely what makes the store retry it later.
 *
 * Throws when the server DEFINITIVELY rejects the purchase, because a
 * transaction that will never verify should be finished rather than
 * re-delivered on every launch forever.
 */
async function verify(transaction: NativeTransaction): Promise<VerifyResult | null> {
  let response: Response;
  try {
    response = await fetch('/api/mobile/iap/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        platform: transaction.platform,
        productId: transaction.productId,
        transactionId: transaction.transactionId,
        token: transaction.token,
        packageName: transaction.packageName,
      }),
    });
  } catch {
    // Network failure: keep the transaction so the store re-delivers it.
    return null;
  }

  if (response.ok) return (await response.json()) as VerifyResult;

  // ⚠️ FAIL SAFE, NOT FAIL FAST. Throwing here makes the caller finish the
  // transaction, which on Android CONSUMES it at Google — it is never
  // re-delivered and never auto-refunded, so the player has paid and can never
  // be given anything. Only an explicit "this purchase is not real" from our
  // server may do that; everything else keeps the transaction alive.
  //
  // 401 is the case that made this necessary: the store flushes queued
  // transactions at launch, often before the session cookie exists, so a
  // perfectly good purchase arrives unauthenticated. Treating that as a
  // definitive rejection destroyed it.
  if (response.status >= 500) return null;
  if ([401, 403, 408, 429].includes(response.status)) return null;

  let body: { error?: string; retryable?: boolean; definitive?: boolean } = {};
  try {
    body = await response.json();
  } catch {
    return null; // unparseable: assume transient rather than destroy the purchase
  }
  if (body.retryable) return null;

  // The server must say so explicitly. Absence of the flag is not consent.
  if (!body.definitive) return null;

  throw new Error(body.error || 'This purchase could not be verified.');
}

/**
 * In-flight settles, keyed by transaction id.
 *
 * StoreKit's `Transaction.updates` listener ALSO fires for a purchase made
 * through `purchase()`, so without this the foreground call and the background
 * listener verify the same transaction simultaneously. On the very first real
 * App Store purchase that is exactly what happened: the credits were granted
 * once (the ledger's unique index held), but the losing request hit that index,
 * 500'd, and the player was told "payment went through but we could not confirm
 * it" — on a purchase that had in fact worked perfectly.
 *
 * Sharing the promise means the second caller awaits the first's result instead
 * of racing it, so both report the same honest outcome.
 */
const inFlight = new Map<string, Promise<VerifyResult | null>>();

/** Verifies, THEN finishes. The order is the whole point. */
function settle(transaction: NativeTransaction): Promise<VerifyResult | null> {
  const existing = inFlight.get(transaction.transactionId);
  if (existing) return existing;

  const run = (async () => {
    const result = await verify(transaction);
    if (!result) return null; // transient: leave unfinished, the store retries

    await bridge()?.finish({
      transactionId: transaction.transactionId,
      consume: result.consume,
    });
    return result;
  })();

  inFlight.set(transaction.transactionId, run);
  // Keep the entry briefly after settling so a listener firing just after the
  // foreground call resolves still joins rather than starting a second round.
  void run.finally(() => {
    setTimeout(() => inFlight.delete(transaction.transactionId), 30_000);
  });

  return run;
}

let initialised = false;
let listenerAttached = false;
let cachedAccountToken: string | undefined;

/**
 * Connects to the store and loads prices.
 *
 * The unsolicited-transaction listener is attached BEFORE initialize, because
 * both stores flush queued transactions the moment something connects and a
 * listener added afterwards misses them. Those queued transactions are exactly
 * the ones that matter most: a purchase interrupted mid-flight, or an
 * Ask-to-Buy a parent approved hours later.
 *
 * `onBackgroundGrant` fires when one of those lands and credits are granted, so
 * the UI can refresh a balance the player did not just click for.
 */
export async function initIap(
  onBackgroundGrant?: (result: VerifyResult) => void,
): Promise<IapProduct[]> {
  const iap = bridge();
  if (!iap) return [];

  const { CREDIT_PACKS } = await import('@/lib/credits/packs');

  let session: { appAccountToken?: string; productIds?: string[] };
  try {
    const res = await fetch('/api/mobile/iap/session');
    if (!res.ok) return [];
    session = await res.json();
  } catch {
    return [];
  }

  cachedAccountToken = session.appAccountToken ?? undefined;
  const productIds = session.productIds ?? [];
  if (!productIds.length) return [];

  if (!listenerAttached) {
    listenerAttached = true;
    await iap.addListener('transactionUpdated', (transaction) => {
      void settle(transaction)
        .then((result) => {
          if (result?.creditsGranted && onBackgroundGrant) onBackgroundGrant(result);
        })
        .catch((error) => {
          // Only reached when the server explicitly declared the purchase
          // invalid (see verify()). Finishing it stops the store re-delivering
          // a transaction that will never verify. Anything transient resolves
          // to null instead and is deliberately left unfinished.
          console.warn('[iap] background transaction definitively rejected:', error);
          void iap.finish({ transactionId: transaction.transactionId, consume: true });
        });
    });
  }

  if (!initialised) {
    // The native plugin opens its billing connection at app launch and
    // initialize() only checks isReady() — reach this screen before that
    // connection settles and it reports unavailable with no retry, which
    // rendered the store permanently empty (emulator logcat, 2 Sep: two
    // racing connects, "Reconnection failed with result: 5"). Retry with
    // backoff: the launch connection settles within a couple of seconds.
    let last: { available: boolean; reason?: string; responseCode?: number; debugMessage?: string } = { available: false };
    for (const delayMs of [0, 2000, 5000, 10000]) {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      last = await iap.initialize({ productIds });
      if (last.available) break;
    }
    if (!last.available) {
      // Beacon the failure so production devices are diagnosable from the
      // server side (the shipped plugin reports no code; new builds do).
      try {
        const { track } = await import('@/lib/analytics/track');
        track('iap_unavailable', { meta: { reason: last.reason ?? 'unknown', code: last.responseCode ?? null, message: last.debugMessage ?? null } });
      } catch { /* diagnostics only */ }
      return [];
    }
    initialised = true;
  }

  const { products } = await iap.getProducts();

  // Merge store pricing with our own catalogue. The PRICE always comes from the
  // store: regional pricing means our cents value is only correct in the base
  // region, and showing a price that differs from the payment sheet is a review
  // rejection. Credits and copy come from us.
  return products
    .map((product) => {
      const packId = product.productId.replace(/^credits_/, '');
      const pack = CREDIT_PACKS.find((p) => p.id === packId);
      if (!pack) return null;
      return {
        productId: product.productId,
        packId: pack.id,
        title: pack.name,
        price: product.price,
        credits: pack.baseCredits + pack.bonusCredits,
        blurb: pack.blurb,
        featured: !!pack.featured,
      } satisfies IapProduct;
    })
    .filter((p): p is IapProduct => p !== null);
}

export type PurchaseOutcome =
  | { status: 'granted'; creditsGranted: number; balance: number | null }
  | { status: 'already' }
  | { status: 'pending' }
  | { status: 'cancelled' }
  | { status: 'retry' };

/**
 * Runs a purchase end to end.
 *
 * 'pending' is NOT a failure: Ask-to-Buy is waiting on a parent, or a slow
 * payment method has not cleared. It may complete later and arrive through the
 * background listener, so the UI must say "waiting for approval" and never
 * "purchase failed".
 *
 * 'retry' means paid but not yet granted. The transaction is deliberately left
 * unfinished so the store re-delivers it.
 */
export async function purchasePack(packId: string): Promise<PurchaseOutcome> {
  const iap = bridge();
  if (!iap) throw new Error('In-app purchase is not available.');

  const { status, transaction } = await iap.purchase({
    productId: `credits_${packId}`,
    appAccountToken: cachedAccountToken,
  });

  if (status === 'cancelled') return { status: 'cancelled' };
  if (status === 'pending' || !transaction) return { status: 'pending' };

  const result = await settle(transaction);
  if (!result) return { status: 'retry' };
  if (result.alreadyProcessed) return { status: 'already' };

  return {
    status: 'granted',
    creditsGranted: result.creditsGranted,
    balance: result.balance,
  };
}

/** Platform label for analytics and copy. */
export function iapPlatform(): 'ios' | 'android' | 'web' {
  if (!isNativeApp()) return 'web';
  return getNativePlatform() === 'ios' ? 'ios' : 'android';
}
