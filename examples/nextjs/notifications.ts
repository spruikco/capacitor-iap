// EXAMPLE, not a drop-in. Lifted from a production Next.js app (App Router,
// drizzle + postgres, a credits ledger). Imports from '@/lib/...' are that
// app's own auth, database and ledger; replace them with yours. The shape of
// the flow and the comments are the part worth keeping.

import { sql } from 'drizzle-orm';

import { recordCreditChange } from '@/lib/credits/ledger';
import { db } from '@/server/db/client';

/**
 * Shared handling for App Store Server Notifications V2 and Play Real-time
 * Developer Notifications.
 *
 * These are the only way we ever learn that money went back. A refund happens
 * entirely between the player and the store; nothing in the app is involved and
 * no request reaches us. Without this path a refunded credit pack is money out
 * with the goods kept, permanently and silently.
 *
 * Every handler here must be idempotent: both stores retry until they get a
 * 2xx, and both can deliver the same notification more than once regardless.
 */

export type IapPlatform = 'ios' | 'android';

/**
 * postgres-js returns rows as a bare array; other drivers wrap them in
 * `{ rows }`. Same helper as lib/credits/ledger.ts and the end-of-season
 * modules — kept local for the same reason they do.
 */
function getRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result : (result as { rows: T[] }).rows || [];
}

/**
 * Claims a notification for processing.
 *
 * Returns false if it has been seen before, in which case the caller should
 * acknowledge (2xx) and do nothing else. Insert-first rather than
 * check-then-insert so two concurrent deliveries cannot both proceed.
 */
export async function claimNotification(
  platform: IapPlatform,
  notificationId: string,
  notificationType: string | null,
  subtype: string | null,
  payload: unknown,
): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO iap_notifications (platform, notification_id, notification_type, subtype, payload)
    VALUES (${platform}, ${notificationId}, ${notificationType}, ${subtype}, ${JSON.stringify(payload ?? null)}::jsonb)
    ON CONFLICT (platform, notification_id) DO NOTHING
    RETURNING id
  `);
  return getRows<{ id: number }>(result).length > 0;
}

export async function markNotificationProcessed(
  platform: IapPlatform,
  notificationId: string,
  error?: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE iap_notifications
       SET processed_at = ${error ? null : sql`now()`}, error = ${error ?? null}
     WHERE platform = ${platform} AND notification_id = ${notificationId}
  `);
}

/**
 * Releases a claim so the notification can be processed again.
 *
 * `claimNotification` dedupes by inserting first, which is right for stopping
 * double-processing — but it also meant a handler that threw left the row
 * recorded forever while the endpoint returned 2xx. The store then stopped
 * retrying and nothing replayed it, so a REFUND lost to a momentary database
 * blip was lost permanently: money returned, credits kept, silently.
 *
 * The payload is preserved on the row before deletion by the caller, so
 * releasing costs nothing; the store's own retry (Apple retries for three days,
 * Pub/Sub until acked) becomes the recovery path again.
 */
export async function releaseNotificationClaim(
  platform: IapPlatform,
  notificationId: string,
): Promise<void> {
  await db.execute(sql`
    DELETE FROM iap_notifications
     WHERE platform = ${platform}
       AND notification_id = ${notificationId}
       AND processed_at IS NULL
  `);
}

interface PurchaseRow {
  id: number;
  manager_id: number;
  product_id: string;
  credits_granted: number;
  state: string;
}

/**
 * Reverses a refunded or revoked purchase.
 *
 * `allowNegative` is deliberate: the player has very likely already spent the
 * credits, so a clawback will often push the balance below zero. Refusing to go
 * negative would mean a refund that takes the money back but leaves the goods,
 * which is strictly worse. A negative balance simply blocks further spending
 * until it is earned or bought back.
 */
export async function reversePurchase(
  platform: IapPlatform,
  transactionId: string,
  newState: 'refunded' | 'revoked',
): Promise<{ found: boolean; clawedBack: number }> {
  const result = await db.execute(sql`
    SELECT id, manager_id, product_id, credits_granted, state
      FROM iap_purchases
     WHERE platform = ${platform} AND transaction_id = ${transactionId}
     LIMIT 1
  `);

  const purchase = getRows<PurchaseRow>(result)[0];
  if (!purchase) {
    // A store transaction we have no record of. Usually a purchase whose
    // verify call never reached us (so nothing was granted and there is
    // nothing to reverse), but worth logging because the alternative is a
    // grant we failed to record.
    console.warn(`[iap] ${newState} notification for unknown ${platform} transaction ${transactionId}`);
    return { found: false, clawedBack: 0 };
  }

  // Already reversed: both stores re-deliver, so this is the normal path on a
  // retry, not an anomaly.
  if (purchase.state !== 'granted') {
    return { found: true, clawedBack: 0 };
  }

  // ⚠️ DO NOT TRUST credits_granted ALONE.
  //
  // The ledger grant and the iap_purchases insert are separate transactions. If
  // the process dies between them, the store re-delivers, and the second pass
  // sees the ledger key already used (applied = false) and writes the purchase
  // row with credits_granted = 0. A refund then found the row, skipped the
  // reversal because 0 is not > 0, marked it 'refunded' and logged success —
  // money returned, credits kept, clean audit trail.
  //
  // The ledger is the authority on what was actually granted, so ask it.
  const amount = purchase.credits_granted > 0
    ? purchase.credits_granted
    : await grantedAmountFromLedger(platform, transactionId);

  if (amount > 0) {
    await recordCreditChange({
      managerId: purchase.manager_id,
      delta: -amount,
      reason: 'refund',
      description: `${newState === 'refunded' ? 'Refund' : 'Revocation'} of ${platform === 'ios' ? 'App Store' : 'Google Play'} purchase (${purchase.product_id})`,
      refType: platform === 'ios' ? 'apple_iap' : 'google_iap',
      refId: purchase.id,
      // One clawback per purchase, however many times the store tells us.
      stripeEventId: `${platform}:reverse:${transactionId}`,
      allowNegative: true,
    });
  }

  await db.execute(sql`
    UPDATE iap_purchases
       SET state = ${newState}, resolved_at = now()
     WHERE id = ${purchase.id}
  `);

  if (amount > 0) {
    console.log(
      `[iap] ${newState} ${platform} ${transactionId}: clawed back ${amount} ` +
        `credits from manager ${purchase.manager_id}`,
    );
  } else {
    // Reaching here means neither the purchase row nor the ledger shows a
    // grant. Say so loudly rather than logging a successful-looking zero.
    console.warn(
      `[iap] ${newState} ${platform} ${transactionId}: NOTHING was clawed back — no grant ` +
        `found in iap_purchases or the ledger for manager ${purchase.manager_id}. Check manually.`,
    );
  }

  return { found: true, clawedBack: amount };
}

/**
 * How many credits the ledger actually granted for a store transaction.
 *
 * Checks both the production and sandbox key namespaces, since the verify route
 * prefixes sandbox purchases separately to stop the two id spaces colliding.
 */
async function grantedAmountFromLedger(
  platform: IapPlatform,
  transactionId: string,
): Promise<number> {
  const prefix = platform === 'ios' ? 'apple' : 'google';
  const result = await db.execute(sql`
    SELECT delta FROM credit_transactions
     WHERE stripe_event_id IN (
             ${`${prefix}:${transactionId}`},
             ${`${prefix}:sandbox:${transactionId}`}
           )
       AND delta > 0
     ORDER BY id
     LIMIT 1
  `);
  const row = getRows<{ delta: number | string }>(result)[0];
  return row ? Math.abs(Number(row.delta)) : 0;
}

/** Marks an Android purchase acknowledged, closing its 72-hour clock. */
export async function markAcknowledged(transactionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE iap_purchases
       SET acknowledged = true
     WHERE platform = 'android' AND transaction_id = ${transactionId}
  `);
}

export interface EntitlementUpdate {
  managerId: number;
  platform: IapPlatform;
  productId: string;
  originalTransactionId: string;
  state: 'active' | 'grace_period' | 'on_hold' | 'paused' | 'cancelled' | 'expired' | 'revoked';
  activeUntil: Date | null;
  willRenew: boolean;
}

/** Upserts subscription state. The row is keyed by the store's original transaction id. */
export async function upsertEntitlement(update: EntitlementUpdate): Promise<void> {
  await db.execute(sql`
    INSERT INTO iap_entitlements (
      manager_id, platform, product_id, original_transaction_id,
      state, active_until, will_renew, updated_at
    ) VALUES (
      ${update.managerId}, ${update.platform}, ${update.productId},
      ${update.originalTransactionId}, ${update.state},
      ${update.activeUntil ? update.activeUntil.toISOString() : null},
      ${update.willRenew}, now()
    )
    ON CONFLICT (platform, original_transaction_id) DO UPDATE
      SET state        = EXCLUDED.state,
          active_until = EXCLUDED.active_until,
          will_renew   = EXCLUDED.will_renew,
          product_id   = EXCLUDED.product_id,
          updated_at   = now()
  `);
}

/**
 * Finds the manager behind a store transaction.
 *
 * Order matters. The purchase record is the reliable answer; the account token
 * we stamped on at purchase time is the fallback for the case the record is
 * missing, which is precisely the case where the original verify call never
 * reached us. That fallback is why purchases carry an appAccountToken at all.
 */
export async function managerForTransaction(
  platform: IapPlatform,
  originalTransactionId: string,
  appAccountToken?: string,
): Promise<number | null> {
  const byPurchase = await db.execute(sql`
    SELECT manager_id FROM iap_purchases
     WHERE platform = ${platform} AND original_transaction_id = ${originalTransactionId}
     ORDER BY created_at DESC LIMIT 1
  `);
  const found = getRows<{ manager_id: number }>(byPurchase)[0];
  if (found) return found.manager_id;

  if (appAccountToken) {
    const byToken = await db.execute(sql`
      SELECT id FROM managers WHERE app_account_token = ${appAccountToken} LIMIT 1
    `);
    const manager = getRows<{ id: number }>(byToken)[0];
    if (manager) return manager.id;
  }

  return null;
}
