# Examples

`nextjs/` is the server side of a shipped app, lifted out with the app-specific
bits (auth helper, drizzle client, credits ledger) left as `@/lib/...` imports
for you to swap. It is here for the shape and the comments, which record every
mistake the real integration made on the way to App Review and Play review.

| File | Role |
|---|---|
| `verify-route.ts` | `POST /api/mobile/iap/verify`. The only place goods are granted. Looks the product up in **your** catalogue by the id the **store** reports, never from the request body. Idempotent on transaction id. |
| `session-route.ts` | Returns the product ids to load and an opaque per-user `appAccountToken`, so refunds learned about later can be attributed. |
| `apple-notifications-route.ts` | App Store Server Notifications V2. Verified with the same JWS verifier; handles refunds and renewals. Set the **sandbox** URL too or TestFlight and App Review exercise nothing. |
| `google-notifications-route.ts` | Play Real-time Developer Notifications via Pub/Sub push. Fails closed if the shared secret is unset. |
| `notifications.ts` | The shared refund and renewal handling both endpoints call into. |
| `client.ts` | The web-side wrapper: attach the listener before `initialize`, verify, then `finish`. Falls back to the web payment rail in a browser. |
| `migration.sql` | `iap_purchases` and `iap_entitlements`. Purchases are the audit log keyed on transaction id; entitlements are the server's view of active subscriptions, which is the authority, not the client's. |

Env flags the example gates on, so it can ship inert before the stores are configured:

| Variable | Purpose |
|---|---|
| `APPLE_IAP_ENABLED=1` | Switch the iOS rail on. Absent means 503 and no charge. |
| `GOOGLE_IAP_ENABLED=1` | Switch the Android rail on. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Service account key for the Play Developer API. |
| `GOOGLE_RTDN_SECRET` | Shared secret appended to the RTDN push URL as `?secret=`. |
