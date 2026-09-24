// EXAMPLE, not a drop-in. Lifted from a production Next.js app (App Router,
// drizzle + postgres, a credits ledger). Imports from '@/lib/...' are that
// app's own auth, database and ledger; replace them with yours. The shape of
// the flow and the comments are the part worth keeping.

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { requireAuth } from '@/lib/auth-helpers';
import { grantCredits } from '@/lib/credits/ledger';
import { CREDIT_PACKS } from '@/lib/credits/packs';
import { AppleJwsError, verifyAppleJws, type AppleTransactionInfo } from '@spruik/capacitor-iap-server/apple-jws';
import { GooglePlayError, verifyProductPurchase } from '@spruik/capacitor-iap-server/google-play';
import { db } from '@/server/db/client';

/**
 * In-app purchase verification — the ONLY place credits are granted for an App
 * Store or Play purchase (mirroring the Stripe webhook's role on the web rail).
 *
 * Client flow (lib/iap/client.ts):
 *   store purchase -> POST the token here -> we verify with Apple/Google ->
 *   grant via the ledger -> 200 -> client calls finish() so the store stops
 *   re-delivering.
 *
 * The client's word is never trusted. In particular the pack granted is looked
 * up in OUR catalogue by the product id the STORE reports, never from anything
 * the request body claims, so a tampered client cannot buy the cheapest pack
 * and ask for the largest.
 *
 * ── What changed, and why ───────────────────────────────────────────────────
 * This used to POST a base64 receipt to Apple's `verifyReceipt`. That endpoint
 * is deprecated, needed a shared secret, and put a network call to Apple in the
 * middle of every purchase. StoreKit 2 payloads are signed, so iOS is now
 * verified offline against Apple's pinned root certificate: no secret, no round
 * trip, no dependency on Apple's uptime at the moment of purchase.
 *
 * Android cannot work that way. Play gives the client an opaque token that
 * means nothing without asking Google, so that path does call out.
 *
 * Idempotent on both platforms via the ledger's unique-event key, so replays,
 * retries and re-delivered transactions can never double-credit.
 */

const BUNDLE_ID = 'com.example.app';

/** postgres-js returns a bare array; see lib/credits/ledger.ts for the same helper. */
function getRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result : (result as { rows: T[] }).rows || [];
}

/**
 * Store product id -> pack. Product ids mirror lib/credits/packs.ts 1:1
 * (`credits_starter`, `credits_standard`, ...) exactly as that file promised.
 */
const PACK_BY_PRODUCT: Record<string, { packId: string; credits: number }> = Object.fromEntries(
  CREDIT_PACKS.map((p) => [
    `credits_${p.id}`,
    { packId: p.id, credits: p.baseCredits + p.bonusCredits },
  ]),
);

interface VerifyRequest {
  platform?: 'ios' | 'android';
  productId?: string;
  transactionId?: string;
  token?: string;
  packageName?: string;
}

/** Outcome of a platform-specific verification, normalised. */
interface VerifiedPurchase {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  environment: string;
  /** Android purchases start unacknowledged; the client acknowledges after our 200. */
  acknowledged: boolean;
}

function enabledFor(platform: 'ios' | 'android'): boolean {
  return platform === 'ios'
    ? process.env.APPLE_IAP_ENABLED === '1'
    : process.env.GOOGLE_IAP_ENABLED === '1';
}

/**
 * Rejects a purchase that the store says belongs to a DIFFERENT account.
 *
 * Both stores echo back the opaque account id we stamped on at purchase time.
 * Checking it closes an attack the ledger alone does not: the ledger's
 * unique-event key stops the same transaction granting TWICE, but it does not
 * care WHO the first grant goes to. So a stolen-but-never-verified payload
 * (bought on one device, app died before our verify call landed) could be
 * replayed by another account and credited to them, with the rightful buyer
 * then locked out because the key is already spent.
 *
 * Only enforced when the store actually returns a token — purchases made
 * before the account got one legitimately have none.
 *
 * A genuine mismatch is possible and correct to reject: signing into a second
 * account on the same device can deliver the first account's transaction. Those
 * credits belong to the account that paid.
 */
function assertAccountMatches(
  storeToken: string | undefined,
  managerToken: string | null,
  managerId: number,
): void {
  // No token from the store: nothing to compare. Purchases made before this
  // account had one legitimately have none.
  if (!storeToken) return;

  // The store DID name an account. `managerToken` is always minted before this
  // runs (see the COALESCE in POST), so a null here would mean the manager
  // could not be resolved at all — refuse rather than skip. Skipping when
  // either side was absent was the hole: an attacker with someone else's
  // unverified payload only had to use an account that had never opened the
  // native app, and the check waved them through.
  if (!managerToken) {
    throw new AppleJwsError('This purchase belongs to a different account.');
  }
  if (storeToken.toLowerCase() === managerToken.toLowerCase()) return;

  console.warn(
    `[iap] account token mismatch for manager ${managerId}: the store attributes this ` +
      `purchase to a different account. Refusing to grant.`,
  );
  throw new AppleJwsError('This purchase belongs to a different account.');
}

async function verifyApple(
  body: VerifyRequest,
  managerToken: string | null,
  managerId: number,
): Promise<VerifiedPurchase> {
  const payload = verifyAppleJws<AppleTransactionInfo>(body.token!);

  if (payload.bundleId !== BUNDLE_ID) {
    throw new AppleJwsError(`Transaction is for a different app (${payload.bundleId})`);
  }

  assertAccountMatches(payload.appAccountToken, managerToken, managerId);

  // A refunded or revoked transaction is signed and genuine but must not grant.
  // StoreKit re-delivers revoked transactions so the app can remove access;
  // granting on one would hand out credits for money that went back.
  if (payload.revocationDate) {
    throw new AppleJwsError('Transaction has been revoked or refunded');
  }

  // The signed payload is authoritative; the body is only a hint. If they
  // disagree, something is wrong enough not to proceed.
  if (body.transactionId && body.transactionId !== payload.transactionId) {
    throw new AppleJwsError('Transaction id does not match the signed payload');
  }

  // See the Android note: quantity was decoded and then ignored while a flat
  // pack size was granted. Refuse rather than under-deliver on a paid purchase.
  if (payload.quantity !== undefined && payload.quantity !== 1) {
    console.error(
      `[iap] App Store purchase with quantity=${payload.quantity} for '${payload.productId}'. ` +
        `Multi-quantity is not supported — the player has been charged for more than we grant.`,
    );
    throw new AppleJwsError('Multi-quantity purchases are not supported.');
  }

  return {
    productId: payload.productId,
    transactionId: payload.transactionId,
    originalTransactionId: payload.originalTransactionId ?? payload.transactionId,
    environment: payload.environment ?? 'Production',
    acknowledged: true, // iOS has no acknowledgement concept.
  };
}

async function verifyGoogle(
  body: VerifyRequest,
  managerToken: string | null,
  managerId: number,
): Promise<VerifiedPurchase> {
  const packageName = body.packageName || BUNDLE_ID;
  if (packageName !== BUNDLE_ID) {
    throw new GooglePlayError(`Purchase is for a different app (${packageName})`, true);
  }
  if (!body.productId) {
    throw new GooglePlayError('productId is required on Android', true);
  }

  // ⚠️ On Android the product id is CLIENT-SUPPLIED and unavoidably so: Google's
  // API is addressed BY product id, and its response echoes no product back. So
  // nothing Google returns confirms what was actually bought.
  //
  // The only thing standing between "pay for the Starter pack, claim the
  // Stockpile" is that purchases.products.get 400s on a token/product mismatch.
  // That behaviour is real but undocumented, so it is a thin thing to rest
  // revenue on. Constrain the input to our catalogue BEFORE it reaches Google,
  // so at worst an attacker can only substitute one of four known packs and
  // still has to survive Google's mismatch check.
  if (!PACK_BY_PRODUCT[body.productId]) {
    throw new GooglePlayError(`Unknown product '${body.productId}'`, true);
  }

  const purchase = await verifyProductPurchase(packageName, body.productId, body.token!);

  // `quantity` is returned by both stores and was being ignored while a flat
  // pack size was granted. Always 1 today (multi-quantity is an opt-in Play
  // Console setting and StoreKit needs an explicit .quantity option), but if it
  // is ever switched on, a player paying for five packs would receive one.
  // Refuse rather than under-deliver, and make it loud.
  if (purchase.quantity !== undefined && purchase.quantity !== 1) {
    console.error(
      `[iap] Play purchase with quantity=${purchase.quantity} for '${body.productId}'. ` +
        `Multi-quantity is not supported — the player has been charged for more than we grant.`,
    );
    throw new GooglePlayError('Multi-quantity purchases are not supported.', false);
  }

  // 0 = purchased, 1 = cancelled, 2 = pending.
  if (purchase.purchaseState !== 0) {
    // PENDING is explicitly NOT definitive. It is a deferred payment (cash at a
    // till, carrier billing) that Google WILL re-evaluate, so calling it
    // definitive made the client consume a purchase the player was about to pay
    // for. Only "cancelled" is final.
    throw new GooglePlayError(
      purchase.purchaseState === 2
        ? 'Purchase is still pending payment'
        : 'Purchase was cancelled',
      purchase.purchaseState !== 2,
    );
  }

  assertAccountMatches(purchase.obfuscatedExternalAccountId, managerToken, managerId);

  return {
    productId: body.productId,
    transactionId: body.token!,
    originalTransactionId: purchase.orderId ?? body.token!,
    // 1 = licence tester, 2 = promo code; anything else (including an explicit
    // 0, which Google may send) is real revenue. Treating "any defined value"
    // as Sandbox would have tagged genuine purchases as test — harmless while
    // nothing read the field, but a hard revenue outage now that the sandbox
    // gate does.
    environment:
      purchase.purchaseType === 1 || purchase.purchaseType === 2 ? 'Sandbox' : 'Production',
    acknowledged: purchase.acknowledgementState === 1,
  };
}

export async function POST(request: Request) {
  let managerId: number | undefined;
  try {
    const auth = await requireAuth();
    managerId = auth.managerId;

    const body = (await request.json()) as VerifyRequest;
    const platform = body.platform === 'android' ? 'android' : body.platform === 'ios' ? 'ios' : null;

    if (!platform) {
      return NextResponse.json({ error: "platform must be 'ios' or 'android'" }, { status: 400 });
    }
    if (!body.token || typeof body.token !== 'string' || body.token.length > 100_000) {
      return NextResponse.json({ error: 'token is required' }, { status: 400 });
    }
    if (!enabledFor(platform)) {
      return NextResponse.json(
        { error: 'In-app purchase is not yet available. No charge has been made by us.' },
        { status: 503 },
      );
    }

    // The opaque id we handed the store for this manager. MINTED HERE if absent
    // rather than merely read: a null token used to disable the ownership check
    // entirely, so an attacker replaying someone else's payload just had to use
    // an account that had never opened the native app. COALESCE keeps an
    // existing token stable, which matters because the stores record it against
    // purchases permanently.
    const tokenRows = await db.execute(sql`
      UPDATE managers
         SET app_account_token = COALESCE(app_account_token, gen_random_uuid())
       WHERE id = ${managerId}
       RETURNING app_account_token
    `);
    const managerToken =
      getRows<{ app_account_token: string | null }>(tokenRows)[0]?.app_account_token ?? null;

    const verified =
      platform === 'ios'
        ? await verifyApple(body, managerToken, managerId)
        : await verifyGoogle(body, managerToken, managerId);

    // ── Sandbox must not mint real credits ────────────────────────────────
    // TestFlight, App Review and Play licence testers all transact against the
    // stores' sandboxes. Those payloads are signed by the real Apple chain and
    // verify identically, but the purchases are FREE and endlessly repeatable —
    // so without this gate any external tester could farm unlimited credits on
    // their live account.
    const isSandbox = verified.environment !== 'Production';
    if (isSandbox && process.env.IAP_ALLOW_SANDBOX !== '1') {
      console.warn(
        `[iap] refused a ${verified.environment} purchase for manager ${managerId} ` +
          `(${verified.productId}). Set IAP_ALLOW_SANDBOX=1 to allow test purchases to grant.`,
      );
      return NextResponse.json(
        {
          error:
            'Test-environment purchases do not grant credits. No charge has been made by us.',
          definitive: true,
        },
        { status: 400 },
      );
    }

    const pack = PACK_BY_PRODUCT[verified.productId];
    if (!pack) {
      // A genuine, verified purchase of something we do not sell. This is OUR
      // configuration fault (a renamed pack id, a store product added before
      // the catalogue shipped), never a statement about the purchase — so it
      // must be retryable. Returning it as definitive made the client consume
      // a paid purchase and grant nothing.
      console.error(
        `[iap] verified ${platform} purchase of unknown product '${verified.productId}' ` +
          `for manager ${managerId}. Store catalogue and lib/credits/packs.ts have diverged.`,
      );
      return NextResponse.json(
        { error: 'This pack is temporarily unavailable.', retryable: true },
        { status: 503 },
      );
    }

    // Sandbox and production transaction-id spaces are SEPARATE and can
    // collide, so the idempotency key is namespaced by environment. Without
    // that, a sandbox transaction could permanently burn the key belonging to a
    // real one — the paying customer would get `alreadyProcessed` and nothing.
    const prefix = platform === 'ios' ? 'apple' : 'google';
    const eventKey = isSandbox
      ? `${prefix}:sandbox:${verified.transactionId}`
      : `${prefix}:${verified.transactionId}`;

    const result = await grantCredits({
      managerId,
      amount: pack.credits,
      reason: 'purchase',
      description: `${platform === 'ios' ? 'App Store' : 'Google Play'} purchase: ${pack.credits} credits (${verified.productId})`,
      refType: platform === 'ios' ? 'apple_iap' : 'google_iap',
      // Replay-proof: one grant per store transaction, ever.
      stripeEventId: eventKey,
    });

    // Record the store-id -> manager mapping. Without this a refund
    // notification arriving days later cannot be attributed to anyone, and the
    // credits stay handed out. ON CONFLICT because the grant above is
    // idempotent and this must be too.
    await db.execute(sql`
      INSERT INTO iap_purchases (
        manager_id, platform, product_id, transaction_id, original_transaction_id,
        credits_granted, environment, state, acknowledged
      ) VALUES (
        ${managerId}, ${platform}, ${verified.productId}, ${verified.transactionId},
        ${verified.originalTransactionId}, ${result.applied ? pack.credits : 0},
        ${verified.environment}, 'granted', ${verified.acknowledged}
      )
      ON CONFLICT (platform, transaction_id) DO NOTHING
    `);

    if (result.applied) {
      console.log(
        `[iap] manager ${managerId} granted ${pack.credits} credits ` +
          `(${platform} ${verified.transactionId}, ${verified.environment})`,
      );
    }

    return NextResponse.json({
      success: true,
      creditsGranted: result.applied ? pack.credits : 0,
      balance: result.balanceAfter,
      alreadyProcessed: !result.applied,
      // Credit packs are consumables, so the client consumes rather than
      // acknowledges on Android. Sent explicitly so the client never has to
      // guess: acknowledging a consumable makes it unbuyable ever again.
      consume: true,
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // A failed verification is a 400, not a 500: it is a statement about the
    // purchase, not about us. The client must NOT finish the transaction on a
    // 400 for a transient reason, so the two are kept distinct below.
    // `definitive: true` is the client's ONLY licence to finish a transaction,
    // which on Android consumes it at Google irreversibly. A failed signature
    // or an account mismatch will never succeed on retry, so those qualify.
    if (error instanceof AppleJwsError) {
      console.warn(`[iap] apple verification rejected for manager ${managerId}: ${error.message}`);
      return NextResponse.json({ error: error.message, definitive: true }, { status: 400 });
    }
    if (error instanceof GooglePlayError) {
      console.warn(`[iap] play verification failed for manager ${managerId}: ${error.message}`);
      // Non-definitive means Google was unreachable, erroring, or the payment
      // is still pending: retryable, so the client keeps the transaction rather
      // than treating a Google outage as a bad purchase.
      return NextResponse.json(
        {
          error: error.message,
          retryable: !error.definitive,
          definitive: error.definitive,
        },
        { status: error.definitive ? 400 : 503 },
      );
    }

    console.error('[iap] verify failed:', error);
    return NextResponse.json({ error: 'Verification failed', retryable: true }, { status: 500 });
  }
}
