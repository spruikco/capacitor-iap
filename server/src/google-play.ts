import { createSign } from 'node:crypto';

/**
 * Google Play purchase verification via the Play Developer API.
 *
 * ── Why this is shaped differently to the Apple side ────────────────────────
 * Apple hands the client a signed payload we can verify offline. Google hands
 * the client an opaque `purchaseToken` that means nothing on its own, so the
 * server MUST call Google to learn anything about it. That means:
 *
 *   • a network round-trip inside the buy path (Apple has none)
 *   • a service-account credential in our environment (Apple needs none)
 *   • Google's availability is in our critical path
 *
 * There is no way around it; it is how Play works.
 *
 * ⚠️ THE THREE-DAY RULE. Google automatically refunds any purchase that is not
 * acknowledged or consumed within 72 hours. So a verification outage is not
 * merely a delayed grant the way it is on iOS: left unattended it silently
 * hands the money back. `acknowledgementState` in the responses below is what
 * the reconciliation job watches.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

export class GooglePlayError extends Error {
  constructor(
    message: string,
    /** True when Google said the token is invalid, i.e. definitively not a real purchase. */
    readonly definitive: boolean = false,
  ) {
    super(message);
    this.name = 'GooglePlayError';
  }
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function serviceAccount(): ServiceAccount {
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new GooglePlayError(
      'GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not set. Create a service account in the Google ' +
        'Play Console (Users and permissions), grant it "View financial data" and "Manage ' +
        'orders and subscriptions", and put its JSON key in that variable.',
    );
  }
  let parsed: ServiceAccount;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new GooglePlayError('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not valid JSON.');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new GooglePlayError('GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is missing client_email or private_key.');
  }
  // Keys pasted into an env var usually arrive with literal \n rather than real
  // newlines, which makes the signer fail with an opaque PEM error.
  parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
}

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Cached access token. Google's live for an hour; refresh a minute early. */
let cachedToken: { value: string; expiresAt: number } | null = null;

async function accessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const account = serviceAccount();
  const now = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };

  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify(claim))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const assertion = `${unsigned}.${b64url(signer.sign(account.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    throw new GooglePlayError(`Google token exchange failed (${res.status}): ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new GooglePlayError('Google token exchange returned no access_token.');
  }

  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000,
  };
  return cachedToken.value;
}

async function playGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}/${path}`, {
    headers: { Authorization: `Bearer ${await accessToken()}` },
  });

  if (res.status === 400 || res.status === 404 || res.status === 410) {
    // Google is telling us the token is not a real, current purchase. Unlike a
    // 5xx this will never succeed on retry, so it is safe (and important) to
    // treat it as a definitive rejection rather than retrying forever.
    throw new GooglePlayError(`Play rejected the purchase token (${res.status}): ${await res.text()}`, true);
  }
  if (!res.ok) {
    throw new GooglePlayError(`Play API error (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}

/** One-time product purchase, from purchases.products.get. */
export interface PlayProductPurchase {
  /** 0 = purchased, 1 = cancelled, 2 = pending. */
  purchaseState: number;
  /** 0 = not consumed, 1 = consumed. */
  consumptionState: number;
  /** 0 = not acknowledged, 1 = acknowledged. The three-day clock. */
  acknowledgementState: number;
  /** 0 = normal purchase, 1 = test (licence tester), 2 = promo. */
  purchaseType?: number;
  orderId?: string;
  purchaseTimeMillis?: string;
  /** What we passed as setObfuscatedAccountId at purchase time. */
  obfuscatedExternalAccountId?: string;
  regionCode?: string;
  quantity?: number;
}

/** Subscription purchase, from purchases.subscriptionsv2.get. */
export interface PlaySubscriptionPurchase {
  subscriptionState:
    | 'SUBSCRIPTION_STATE_ACTIVE'
    | 'SUBSCRIPTION_STATE_CANCELED'
    | 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
    | 'SUBSCRIPTION_STATE_ON_HOLD'
    | 'SUBSCRIPTION_STATE_PAUSED'
    | 'SUBSCRIPTION_STATE_EXPIRED'
    | 'SUBSCRIPTION_STATE_PENDING'
    | string;
  lineItems?: Array<{
    productId?: string;
    expiryTime?: string;
    autoRenewingPlan?: { autoRenewEnabled?: boolean };
  }>;
  latestOrderId?: string;
  startTime?: string;
  acknowledgementState?: string;
  externalAccountIdentifiers?: { obfuscatedExternalAccountId?: string };
  testPurchase?: object;
}

export function verifyProductPurchase(
  packageName: string,
  productId: string,
  token: string,
): Promise<PlayProductPurchase> {
  return playGet<PlayProductPurchase>(
    `${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`,
  );
}

async function playPost(path: string, body: unknown = {}): Promise<void> {
  const res = await fetch(`${API_BASE}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  // 400/410 here usually means "already consumed/acknowledged", which is the
  // outcome we wanted anyway. Treat it as success rather than retrying forever.
  if (res.ok || res.status === 400 || res.status === 410) return;
  throw new GooglePlayError(`Play API error (${res.status}): ${await res.text()}`);
}

/**
 * Consumes a one-time purchase SERVER-SIDE, so it can be bought again.
 *
 * This is what makes recovery from a dropped client possible at all: it closes
 * Google's 72-hour auto-refund window without the device ever coming back. If
 * only the client could consume, a player who bought credits and immediately
 * uninstalled would be refunded automatically a few days later, with the
 * credits already granted and spent.
 */
export function consumeProductPurchase(
  packageName: string,
  productId: string,
  token: string,
): Promise<void> {
  return playPost(
    `${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:consume`,
  );
}

/** Acknowledges without consuming — for subscriptions and non-consumables. */
export function acknowledgeProductPurchase(
  packageName: string,
  productId: string,
  token: string,
): Promise<void> {
  return playPost(
    `${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
  );
}

export function verifySubscriptionPurchase(
  packageName: string,
  token: string,
): Promise<PlaySubscriptionPurchase> {
  // subscriptionsv2 (not the v1 `purchases.subscriptions`) because v1 cannot
  // represent multi-item subscriptions and is on its way out.
  return playGet<PlaySubscriptionPurchase>(
    `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(token)}`,
  );
}

/**
 * Is this subscription currently entitled to the goods?
 *
 * Grace period counts as entitled ON PURPOSE: the user's card failed and Google
 * is retrying, and cutting access off mid-retry is how you turn a recoverable
 * billing hiccup into a cancellation. On-hold does not count — by then Google
 * has given up.
 */
export function isSubscriptionActive(purchase: PlaySubscriptionPurchase): boolean {
  return (
    purchase.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' ||
    purchase.subscriptionState === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' ||
    purchase.subscriptionState === 'SUBSCRIPTION_STATE_CANCELED'
    // CANCELED means auto-renew is off but the paid period has not ended yet.
    // Access must run to expiryTime; the caller checks that separately.
  );
}

/** Latest expiry across line items, as epoch ms, or null if absent. */
export function subscriptionExpiryMs(purchase: PlaySubscriptionPurchase): number | null {
  const times = (purchase.lineItems ?? [])
    .map((item) => (item.expiryTime ? Date.parse(item.expiryTime) : NaN))
    .filter((t) => Number.isFinite(t));
  return times.length ? Math.max(...times) : null;
}
