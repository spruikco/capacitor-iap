-- In-app purchase records, subscription entitlements, and store notification
-- de-duplication. Backs the iOS StoreKit 2 / Android Play Billing rail.
--
-- ── Why iap_purchases exists when credit_transactions already logs the grant ─
-- The ledger answers "did this manager get their credits" and is idempotent on
-- stripe_event_id, which is enough for BUYING. It is not enough for what
-- happens afterwards.
--
-- When Apple or Google tells us, days later, that a purchase was refunded or
-- charged back, the notification identifies it by STORE identifiers (a
-- transaction id, an original transaction id, a purchase token) and says
-- nothing about managers or credits. Without a store-id -> manager mapping
-- there is no way to act on it, so today a refunded credit pack is money out
-- with the goods kept, silently and permanently. That is a live hole in the
-- current rail and this table is what closes it.
--
-- ── The three-day rule (Android only) ───────────────────────────────────────
-- Google auto-refunds any purchase not acknowledged within 72 hours. iOS will
-- re-deliver an unfinished transaction indefinitely; Play just hands the money
-- back. `acknowledged` below is what the reconciliation job watches, and it
-- has to run well inside that window.

CREATE TABLE IF NOT EXISTS iap_purchases (
  id                       SERIAL PRIMARY KEY,
  manager_id               INTEGER     NOT NULL,
  platform                 VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
  product_id               VARCHAR(120) NOT NULL,
  -- iOS: StoreKit transaction id. Android: the purchase token, which is the
  -- stable handle there (order ids are absent on pending and some test buys).
  transaction_id           VARCHAR(255) NOT NULL,
  -- Groups a subscription's renewals. Equal to transaction_id for consumables.
  original_transaction_id  VARCHAR(255) NOT NULL,
  credits_granted          INTEGER     NOT NULL DEFAULT 0,
  -- 'Sandbox' purchases come from TestFlight, App Review, and Play licence
  -- testers. Kept so real revenue can be told apart from test traffic.
  environment              VARCHAR(20) NOT NULL DEFAULT 'Production',
  -- granted  -> credits delivered
  -- refunded -> store told us the money went back; credits clawed back
  -- revoked  -> family sharing removed, or the purchase was voided
  state                    VARCHAR(20) NOT NULL DEFAULT 'granted'
                             CHECK (state IN ('granted', 'refunded', 'revoked')),
  -- Android's 72-hour clock. Always true on iOS, which has no equivalent.
  acknowledged             BOOLEAN     NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at              TIMESTAMPTZ
);

-- One row per store transaction. Also the lookup a refund notification uses,
-- so it must be unique and indexed rather than merely indexed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_purchases_txn
  ON iap_purchases (platform, transaction_id);

CREATE INDEX IF NOT EXISTS idx_iap_purchases_original
  ON iap_purchases (platform, original_transaction_id);

CREATE INDEX IF NOT EXISTS idx_iap_purchases_manager
  ON iap_purchases (manager_id, created_at DESC);

-- Finds Android purchases still inside (or falling out of) the 72-hour window.
CREATE INDEX IF NOT EXISTS idx_iap_purchases_unacked
  ON iap_purchases (created_at)
  WHERE acknowledged = false;


-- ── Subscription entitlements ───────────────────────────────────────────────
-- THE authority on whether a manager currently has a subscription. Not the
-- client: renewals, cancellations, billing retries and expiries all happen
-- while the app is closed, so anything the device reports is a stale hint.
--
-- No subscription product ships yet. The table exists now because the store
-- notification handlers that keep it current are the same ones handling
-- refunds, and building half of that plumbing twice is how it ends up
-- inconsistent.
CREATE TABLE IF NOT EXISTS iap_entitlements (
  id                       SERIAL PRIMARY KEY,
  manager_id               INTEGER     NOT NULL,
  platform                 VARCHAR(10) NOT NULL CHECK (platform IN ('ios', 'android')),
  product_id               VARCHAR(120) NOT NULL,
  -- iOS: originalTransactionId. Android: the subscription purchase token.
  original_transaction_id  VARCHAR(255) NOT NULL,
  state                    VARCHAR(30) NOT NULL DEFAULT 'active'
                             CHECK (state IN ('active', 'grace_period', 'on_hold',
                                              'paused', 'cancelled', 'expired', 'revoked')),
  -- Access runs to this instant even after the user cancels: cancelling turns
  -- off renewal, it does not end the paid period. Cutting access at cancel
  -- time would be taking back something already paid for.
  active_until             TIMESTAMPTZ,
  will_renew               BOOLEAN     NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_entitlements_original
  ON iap_entitlements (platform, original_transaction_id);

-- "Is this manager entitled right now" — the read on every gated request.
CREATE INDEX IF NOT EXISTS idx_iap_entitlements_manager_active
  ON iap_entitlements (manager_id, active_until DESC);


-- ── Store notification de-duplication ───────────────────────────────────────
-- Both stores retry a notification until they get a 2xx, and both may deliver
-- the same one more than once regardless. Handlers must therefore be
-- idempotent; this table is how. Insert-first, and if the insert conflicts the
-- notification has already been handled and is acknowledged without replaying
-- its side effects.
--
-- The raw payload is kept because these arrive once, asynchronously, and a
-- handler bug that discards one loses information that cannot be re-requested.
CREATE TABLE IF NOT EXISTS iap_notifications (
  id                SERIAL PRIMARY KEY,
  platform          VARCHAR(10)  NOT NULL CHECK (platform IN ('ios', 'android')),
  -- Apple: notificationUUID. Android: the Pub/Sub message id.
  notification_id   VARCHAR(255) NOT NULL,
  notification_type VARCHAR(80),
  subtype           VARCHAR(80),
  payload           JSONB,
  received_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  processed_at      TIMESTAMPTZ,
  -- Set when handling threw. A row with an error and no processed_at is the
  -- queue of notifications that silently did nothing and need attention.
  error             TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_iap_notifications_unique
  ON iap_notifications (platform, notification_id);

CREATE INDEX IF NOT EXISTS idx_iap_notifications_unprocessed
  ON iap_notifications (received_at)
  WHERE processed_at IS NULL;


-- ── Store-side account attribution ──────────────────────────────────────────
-- An opaque per-manager id we hand to the store at purchase time (Apple's
-- `appAccountToken`, Google's `obfuscatedAccountId`). Both stores echo it back
-- on the purchase and in every notification about it.
--
-- It exists for one specific failure: a purchase completes, the app dies before
-- our verify call lands, and weeks later a refund notification arrives for a
-- transaction we have no record of. The purchase table cannot resolve that;
-- this can. Deliberately NOT the manager id itself — Google asks that the raw
-- account identifier not be sent, and a UUID satisfies Apple's format rule.
ALTER TABLE managers ADD COLUMN IF NOT EXISTS app_account_token UUID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_managers_app_account_token
  ON managers (app_account_token)
  WHERE app_account_token IS NOT NULL;
