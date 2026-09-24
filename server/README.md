# @spruik/capacitor-iap-server

The half of in-app purchases that actually protects the money. Two files, no
dependencies beyond `node:crypto` and `fetch`, usable from any Node server
(Next.js, Express, Hono, a Lambda).

| File | What it does |
|---|---|
| `src/apple-jws.ts` | Verifies StoreKit 2 signed transactions and App Store Server Notifications V2 **offline**. Pins Apple Root CA G3, walks the `x5c` chain, checks validity windows, requires Apple's App Store signing OID on the leaf, then verifies the payload signature. No call to Apple, no shared secret. |
| `src/google-play.ts` | Exchanges a Play `purchaseToken` with the Play Developer API using a service account (self-signed JWT, no SDK). Verify, consume and acknowledge for products; verify and expiry helpers for subscriptions. |
| `test-apple-jws.mts` | The attacks, not the happy path: `alg=none`, foreign root, Apple root with a non-App-Store leaf, truncated chains, malformed input. Run with `npm test`. |

## Apple

```ts
import { verifyAppleJws, AppleJwsError } from './src/apple-jws';

const tx = verifyAppleJws(transaction.token); // throws AppleJwsError on anything forged
// tx.bundleId, tx.productId, tx.transactionId, tx.originalTransactionId,
// tx.environment ('Sandbox' | 'Production'), tx.appAccountToken, ...
```

Check `tx.bundleId` against your own, check `tx.environment` matches the build
you are serving (a Sandbox transaction against production is a tester or an
attacker, either way do not grant), and use `tx.transactionId` as the
idempotency key for whatever you grant.

The same function verifies the `signedPayload` of App Store Server
Notifications V2, so one verifier covers purchases, renewals and refunds.

## Google

```ts
import { verifyProductPurchase, acknowledgeProductPurchase, consumeProductPurchase } from './src/google-play';

const p = await verifyProductPurchase(packageName, productId, purchaseToken);
// p.purchaseState === 0 means purchased; p.acknowledgementState tells you
// whether the 72-hour auto-refund clock is still running.
```

Needs `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` in the environment: the full JSON key
of a service account granted "View financial data" and "Manage orders and
subscriptions" in Play Console. Google auto-refunds anything not acknowledged
or consumed within three days, so acknowledge server-side as soon as you have
granted, and run a reconciliation job that sweeps unacknowledged purchases.

## The flow these are built for

```
client purchase() → POST token to your server
  → verifyAppleJws / verifyProductPurchase
  → grant (idempotent on transactionId)
  → 200 → client finish()
```

`finish()` on the client only after your 200. Until then both stores keep
re-delivering the transaction, which is the retry mechanism you want.

See `../examples/nextjs` for a complete verify route, session route, both
notification endpoints and the SQL for the purchases and entitlements tables.
