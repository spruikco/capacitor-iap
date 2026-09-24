// EXAMPLE, not a drop-in. Lifted from a production Next.js app (App Router,
// drizzle + postgres, a credits ledger). Imports from '@/lib/...' are that
// app's own auth, database and ledger; replace them with yours. The shape of
// the flow and the comments are the part worth keeping.

import { NextResponse } from 'next/server';

import {
  isSubscriptionActive,
  subscriptionExpiryMs,
  verifySubscriptionPurchase,
} from '@spruik/capacitor-iap-server/google-play';
import {
  claimNotification,
  releaseNotificationClaim,
  managerForTransaction,
  markNotificationProcessed,
  reversePurchase,
  upsertEntitlement,
} from './notifications';

/**
 * Google Play Real-time Developer Notifications (RTDN).
 *
 * Play does not POST to you directly: it publishes to a Cloud Pub/Sub topic,
 * and Pub/Sub push-delivers to this URL. Setup is therefore three steps, and
 * missing any one means silence rather than an error:
 *   1. create a Pub/Sub topic and grant
 *      google-play-developer-notifications@system.gserviceaccount.com
 *      the Pub/Sub Publisher role on it
 *   2. point Play Console -> Monetisation setup -> RTDN at that topic
 *   3. add a Pub/Sub PUSH subscription targeting this URL
 *
 * ⚠️ Step 1 needs a GCP project with billing ENABLED. A project that only ever
 * held an API key for something else has usually had billing turned off, and
 * Pub/Sub will refuse to create the topic there.
 *
 * ── Authentication ──────────────────────────────────────────────────────────
 * Unlike Apple's, this body is NOT signed, so the signature cannot be the
 * authentication. Two things stand in:
 *   • a shared secret in the URL (GOOGLE_RTDN_SECRET), which is what Google's
 *     own documentation suggests for push endpoints, and
 *   • re-verifying every purchase token against the Play API before acting on
 *     it, so a forged notification still cannot move credits.
 * The second is the one that actually matters; treat the first as a filter.
 */

interface PubSubEnvelope {
  message?: {
    data?: string;
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

interface DeveloperNotification {
  version?: string;
  packageName?: string;
  eventTimeMillis?: string;
  subscriptionNotification?: {
    version?: string;
    /** 1 RECOVERED, 2 RENEWED, 3 CANCELED, 4 PURCHASED, 5 ON_HOLD,
     *  6 IN_GRACE_PERIOD, 7 RESTARTED, 12 REVOKED, 13 EXPIRED */
    notificationType?: number;
    purchaseToken?: string;
    subscriptionId?: string;
  };
  oneTimeProductNotification?: {
    /** 1 = PURCHASED, 2 = CANCELED. */
    notificationType?: number;
    purchaseToken?: string;
    sku?: string;
  };
  voidedPurchaseNotification?: {
    purchaseToken?: string;
    orderId?: string;
    /** 1 = the purchase itself, 2 = a single item within it. */
    productType?: number;
    /** 1 = refund, 2 = chargeback. */
    refundType?: number;
  };
  testNotification?: { version?: string };
}

export async function POST(request: Request) {
  // FAIL CLOSED. This was `if (secret) { ... }`, so an unset variable disabled
  // the check entirely and left a public endpoint that reverses purchases by
  // token alone — anyone who learned a purchase token could drive a player's
  // balance negative. Unlike the Apple endpoint there is no signature to fall
  // back on, so the secret is mandatory.
  const secret = process.env.GOOGLE_RTDN_SECRET;
  if (!secret) {
    console.error('[iap] GOOGLE_RTDN_SECRET is not set — refusing Play notifications.');
    return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  }
  if (new URL(request.url).searchParams.get('secret') !== secret) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let messageId: string | undefined;

  try {
    const envelope = (await request.json()) as PubSubEnvelope;
    messageId = envelope.message?.messageId;

    if (!envelope.message?.data) {
      // Pub/Sub sometimes delivers control messages with no payload. 2xx or it
      // will redeliver forever.
      return NextResponse.json({ ok: true, empty: true });
    }

    const notification = JSON.parse(
      Buffer.from(envelope.message.data, 'base64').toString('utf8'),
    ) as DeveloperNotification;

    const id = messageId ?? `${notification.eventTimeMillis}:${notificationToken(notification)}`;
    const fresh = await claimNotification('android', id, notificationKind(notification), null, notification);
    if (!fresh) return NextResponse.json({ ok: true, duplicate: true });

    await handle(notification);
    await markNotificationProcessed('android', id);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[iap] play notification failed:', message);

    // Release the claim and answer non-2xx so Pub/Sub redelivers. Previously
    // this recorded the error and returned 2xx, which acked the message —
    // a refund lost to a transient failure was lost for good.
    //
    // Pub/Sub retries with backoff and eventually dead-letters, so this is
    // bounded; an unhandled refund is not.
    if (messageId) {
      await releaseNotificationClaim('android', messageId).catch(() => {});
    }
    return NextResponse.json({ error: 'Handler failed; please retry' }, { status: 500 });
  }
}

function notificationToken(n: DeveloperNotification): string {
  return (
    n.voidedPurchaseNotification?.purchaseToken ??
    n.subscriptionNotification?.purchaseToken ??
    n.oneTimeProductNotification?.purchaseToken ??
    'unknown'
  );
}

function notificationKind(n: DeveloperNotification): string {
  if (n.voidedPurchaseNotification) return 'VOIDED_PURCHASE';
  if (n.subscriptionNotification) return `SUBSCRIPTION_${n.subscriptionNotification.notificationType}`;
  if (n.oneTimeProductNotification) return `ONE_TIME_${n.oneTimeProductNotification.notificationType}`;
  if (n.testNotification) return 'TEST';
  return 'UNKNOWN';
}

const PACKAGE_NAME = 'com.example.app';

async function handle(n: DeveloperNotification): Promise<void> {
  // A test ping from the Play Console. Reaching here proves the whole Pub/Sub
  // chain is wired, which is the hard part of this integration.
  if (n.testNotification) {
    console.log('[iap] Play RTDN test notification received — the Pub/Sub chain works.');
    return;
  }

  // This body is unsigned, so unlike the Apple endpoint there is nothing
  // cryptographic to lean on. Anything naming another package is not ours and
  // must not reach the handlers below — the voided-purchase path in particular
  // reverses a purchase by token alone.
  if (n.packageName && n.packageName !== PACKAGE_NAME) {
    console.warn(`[iap] Play notification for a different package (${n.packageName}) — ignored`);
    return;
  }

  // THE important one: a refund or chargeback. This is the Android counterpart
  // of Apple's REFUND and the reason this endpoint exists.
  if (n.voidedPurchaseNotification?.purchaseToken) {
    await reversePurchase(
      'android',
      n.voidedPurchaseNotification.purchaseToken,
      n.voidedPurchaseNotification.refundType === 2 ? 'revoked' : 'refunded',
    );
    return;
  }

  if (n.oneTimeProductNotification) {
    const token = n.oneTimeProductNotification.purchaseToken;
    if (!token) return;
    // 2 = CANCELED. A purchase Play has cancelled must not stay granted.
    if (n.oneTimeProductNotification.notificationType === 2) {
      await reversePurchase('android', token, 'refunded');
      return;
    }
    // 1 = PURCHASED. Deliberately NOT marked acknowledged here.
    //
    // Play emits this concurrently with the client's verify call, and it
    // asserts only that a purchase happened — NOT that it was consumed. Setting
    // acknowledged = true on this signal removed the row from
    // sweepUnacknowledgedAndroid, so if the app died before consuming, the
    // reconciler never saw it and Google auto-refunded at 72 hours with the
    // credits already granted. That is precisely what the reconciler exists to
    // prevent, and this call was switching it off.
    return;
  }

  const sub = n.subscriptionNotification;
  if (!sub?.purchaseToken || !n.packageName) return;

  // Re-verify against Play rather than trusting the notification's own claim
  // about state. This is what makes a forged notification harmless.
  const purchase = await verifySubscriptionPurchase(n.packageName, sub.purchaseToken);

  const managerId = await managerForTransaction(
    'android',
    sub.purchaseToken,
    purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId,
  );
  if (!managerId) {
    console.warn(`[iap] subscription notification for unattributable token ${sub.purchaseToken}`);
    return;
  }

  const expiryMs = subscriptionExpiryMs(purchase);
  const expired = expiryMs !== null && expiryMs < Date.now();

  await upsertEntitlement({
    managerId,
    platform: 'android',
    productId: sub.subscriptionId ?? purchase.lineItems?.[0]?.productId ?? 'unknown',
    originalTransactionId: sub.purchaseToken,
    state: expired
      ? 'expired'
      : purchase.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
        ? 'grace_period'
        : purchase.subscriptionState === 'SUBSCRIPTION_STATE_ON_HOLD'
          ? 'on_hold'
          : purchase.subscriptionState === 'SUBSCRIPTION_STATE_PAUSED'
            ? 'paused'
            : purchase.subscriptionState === 'SUBSCRIPTION_STATE_CANCELED'
              ? 'cancelled'
              : isSubscriptionActive(purchase)
                ? 'active'
                : 'expired',
    activeUntil: expiryMs ? new Date(expiryMs) : null,
    willRenew: purchase.lineItems?.[0]?.autoRenewingPlan?.autoRenewEnabled ?? false,
  });
}
