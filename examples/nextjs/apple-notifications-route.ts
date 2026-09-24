// EXAMPLE, not a drop-in. Lifted from a production Next.js app (App Router,
// drizzle + postgres, a credits ledger). Imports from '@/lib/...' are that
// app's own auth, database and ledger; replace them with yours. The shape of
// the flow and the comments are the part worth keeping.

import { NextResponse } from 'next/server';

import {
  verifyAppleJws,
  type AppleNotificationPayload,
  type AppleTransactionInfo,
} from '@spruik/capacitor-iap-server/apple-jws';
import {
  claimNotification,
  releaseNotificationClaim,
  managerForTransaction,
  markNotificationProcessed,
  reversePurchase,
  upsertEntitlement,
} from './notifications';

/**
 * App Store Server Notifications V2.
 *
 * Configure the URL in App Store Connect (App Information -> App Store Server
 * Notifications). Set the PRODUCTION and SANDBOX URLs separately; sandbox
 * covers TestFlight and App Review, so without it none of this is exercised
 * before release.
 *
 * ── Why this endpoint matters more than it looks ────────────────────────────
 * REFUND is the only way we ever learn money went back. A refund is agreed
 * between the player and Apple; nothing touches the app and no request reaches
 * us. Before this existed, a refunded credit pack meant the credits stayed
 * spent and the money left, permanently and invisibly.
 *
 * Authentication is the signature, not a secret: the body is a JWS signed by
 * Apple and verified against the pinned Apple root, so the endpoint is safely
 * public. Anything that fails verification is rejected before it can do
 * anything.
 *
 * Always answer 2xx once the notification is recorded. Apple retries on
 * non-2xx for up to three days, and retrying a notification we have already
 * stored just produces duplicates for no benefit.
 */

const BUNDLE_ID = 'com.example.app';

export async function POST(request: Request) {
  let notificationUUID: string | undefined;

  try {
    const body = (await request.json()) as { signedPayload?: string };
    if (!body.signedPayload) {
      return NextResponse.json({ error: 'signedPayload is required' }, { status: 400 });
    }

    // Verifying the signature IS the authentication for this endpoint.
    const payload = verifyAppleJws<AppleNotificationPayload>(body.signedPayload);
    notificationUUID = payload.notificationUUID;

    if (!notificationUUID) {
      return NextResponse.json({ error: 'Notification has no UUID' }, { status: 400 });
    }

    // A valid Apple signature proves Apple sent it, NOT that it concerns us.
    // This endpoint is public, so anyone could relay a genuine notification for
    // another app. In practice the transaction ids would not match anything of
    // ours and the handlers would no-op, but rejecting outright keeps foreign
    // traffic out of iap_notifications where it would look like our data.
    const bundleId = payload.data?.bundleId;
    if (bundleId && bundleId !== BUNDLE_ID) {
      console.warn(`[iap] apple notification for a different app (${bundleId}) — ignored`);
      return NextResponse.json({ ok: true, ignored: true });
    }

    const fresh = await claimNotification(
      'ios',
      notificationUUID,
      payload.notificationType ?? null,
      payload.subtype ?? null,
      payload,
    );
    // Already handled. Acknowledge so Apple stops retrying, and do nothing.
    if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

    await handle(payload);
    await markNotificationProcessed('ios', notificationUUID);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[iap] apple notification failed:', message);

    if (notificationUUID) {
      // RELEASE the claim and answer non-2xx so Apple retries.
      //
      // This used to record the error and return 200, which stopped Apple
      // retrying (it retries for three days) while nothing replayed the row.
      // A REFUND lost to a momentary DB blip was therefore lost permanently:
      // money returned, credits kept, and only a log line to show for it.
      // Apple's own retry is a far better recovery mechanism than anything we
      // would build, so hand the work back to it.
      await releaseNotificationClaim('ios', notificationUUID).catch(() => {});
      return NextResponse.json({ error: 'Handler failed; please retry' }, { status: 500 });
    }

    // Nothing stored (bad signature or malformed body): reject outright.
    return NextResponse.json({ error: 'Notification could not be verified' }, { status: 400 });
  }
}

async function handle(payload: AppleNotificationPayload): Promise<void> {
  const signedTransaction = payload.data?.signedTransactionInfo;
  if (!signedTransaction) return;

  // The nested transaction is its own JWS and gets its own verification. It
  // arrives inside an already-verified envelope, but "signed by Apple" is
  // cheap to confirm and skipping it would be trusting structure over proof.
  const transaction = verifyAppleJws<AppleTransactionInfo>(signedTransaction);
  const type = payload.notificationType;

  switch (type) {
    // Refunded, or revoked (family sharing removal / a reversed charge).
    case 'REFUND':
    case 'REVOKE':
      await reversePurchase(
        'ios',
        transaction.transactionId,
        type === 'REFUND' ? 'refunded' : 'revoked',
      );
      return;

    // Apple is DECIDING on a refund request and is asking what we know. We do
    // not implement the consumption-data reply here: it requires the App Store
    // Server API and, done carelessly, argues against a player's refund on
    // their own money. Recorded and left alone deliberately.
    case 'CONSUMPTION_REQUEST':
      console.log(
        `[iap] Apple requested consumption data for ${transaction.transactionId} ` +
          `(product ${transaction.productId}). Not answered by design.`,
      );
      return;

    // Subscription lifecycle. No subscription product ships yet, so these are
    // recorded for completeness; the entitlement table is already correct for
    // when one does.
    case 'SUBSCRIBED':
    case 'DID_RENEW':
    case 'DID_CHANGE_RENEWAL_STATUS':
    case 'EXPIRED':
    case 'GRACE_PERIOD_EXPIRED':
    case 'DID_FAIL_TO_RENEW': {
      const managerId = await managerForTransaction(
        'ios',
        transaction.originalTransactionId,
        transaction.appAccountToken,
      );
      if (!managerId) {
        console.warn(
          `[iap] ${type} for unattributable subscription ${transaction.originalTransactionId}`,
        );
        return;
      }

      const expires = transaction.expiresDate ? new Date(transaction.expiresDate) : null;
      await upsertEntitlement({
        managerId,
        platform: 'ios',
        productId: transaction.productId,
        originalTransactionId: transaction.originalTransactionId,
        state: subscriptionState(type, payload.subtype, expires),
        activeUntil: expires,
        // Auto-renew off is reported via the DID_CHANGE_RENEWAL_STATUS subtype.
        willRenew: !(type === 'DID_CHANGE_RENEWAL_STATUS' && payload.subtype === 'AUTO_RENEW_DISABLED'),
      });
      return;
    }

    default:
      // Everything else (price consent, offer redemption, test pings) is
      // stored by claimNotification and needs no action.
      return;
  }
}

function subscriptionState(
  type: string,
  subtype: string | undefined,
  expires: Date | null,
): 'active' | 'grace_period' | 'cancelled' | 'expired' {
  if (type === 'EXPIRED' || type === 'GRACE_PERIOD_EXPIRED') return 'expired';
  if (type === 'DID_FAIL_TO_RENEW') {
    // With a GRACE_PERIOD subtype Apple is still retrying the payment, so
    // access continues. Cutting it off here would turn a recoverable card
    // failure into a cancellation.
    return subtype === 'GRACE_PERIOD' ? 'grace_period' : 'expired';
  }
  if (type === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED') {
    // Cancelled, but PAID UP: access must run to expiresDate.
    return 'cancelled';
  }
  if (expires && expires.getTime() < Date.now()) return 'expired';
  return 'active';
}
