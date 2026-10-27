# AGENTS.md: adding in-app purchases with @spruik/capacitor-iap

You are a coding agent adding in-app purchases to a Capacitor 8 app. Follow these steps in order. They are short on purpose: every rule here protects someone's money.

If the app is not Capacitor (React Native, Flutter, native Swift or Kotlin), this plugin is the wrong tool. Use the HTTP guide at https://vend16.com/llms-full.txt instead, or the Claude Code plugin at https://github.com/spruikco/vend16-skill, which has a recipe per platform.

## 0. Check it is a Capacitor 8 app

- There is a `capacitor.config.ts` (or `.json`) at the app root.
- `@capacitor/core` in package.json is version 8 or later. If it is 7 or older, stop and tell the user: this plugin needs Capacitor 8 (iOS uses Swift Package Manager).
- Note the iOS bundle ID (`appId` in capacitor.config) and the Android `applicationId` (android/app/build.gradle). They are usually the same.

## 1. Install

```bash
npm install github:spruikco/capacitor-iap
npx cap sync
```

That is all the native wiring. `cap sync` adds the Swift package to `ios/App/CapApp-SPM/Package.swift` and the Gradle module on Android. Do not edit Podfiles, Package.swift or settings.gradle by hand. Do not rename the package: the npm name decides the Swift package name (`SpruikCapacitorIap`).

Do not run Xcode or Gradle builds unless the user asks: they are slow and need a Mac for iOS.

## 2. Get a Vend16 key (the fast path)

Purchases must be checked with Apple or Google on a server. Vend16 does that for you, so the app needs no backend. It needs a public key (`pk_...`).

Get one in the first way that works:

1. **Vend16 MCP server.** If you have Vend16 tools (`whoami`, `list_apps`, `create_app`, `get_app_keys`), call `list_apps`, then `create_app` with the bundle ID and package name if the app is not there yet, then `get_app_keys` for the public key. Add the server with `claude mcp add --transport http vend16 https://vend16.com/mcp` if the user wants it. *(Depends on the Vend16 MCP server, rolling out now.)*
2. **Vend16 CLI.** Run `npx github:spruikco/vend16-cli init --yes --json` in the app's root. It signs the user in through their browser (they approve a short code at https://vend16.com/activate), creates or finds the app from the bundle ID, writes the public key into the app and prints what is left to set up. *(Depends on the device sign-in, rolling out now.)*
3. **By hand.** Ask the user: "Create a free account at https://vend16.com/signup, add an app with your iOS bundle ID and Android package name, and paste the public key (pk_...) here."

Rules for keys:

- The public key (`pk_...`) is safe in app code. Put it with the app's other public config (an env file read at build time, or a config module), not hard-coded in several places.
- Never ask for, print, log or commit the secret key (`sk_...`). It only belongs in a server's environment as `VEND16_SECRET_KEY`, and only if the app has its own backend.

## 3. Wire it in

Make one module, for example `src/purchases.ts`, and call `startPurchases(userId)` once, as soon as the signed-in user is known:

```ts
import { SpruikIap } from '@spruik/capacitor-iap';
import { createVend16 } from '@spruik/capacitor-iap/vend16';

const vend16 = createVend16({
  apiKey: import.meta.env.VITE_VEND16_PUBLIC_KEY, // pk_...
  // Say what each product is when the ID does not make it obvious.
  productTypes: { pro_monthly: 'subscription', remove_ads: 'non_consumable', coins_100: 'consumable' },
});

export const PRODUCT_IDS = ['coins_100', 'remove_ads', 'pro_monthly'];

export async function startPurchases(userId: string) {
  // 1. Listen BEFORE initialize: the stores replay unfinished purchases on connect.
  await SpruikIap.addListener('transactionUpdated', (tx) => vend16.handle(tx, userId, SpruikIap));
  const { available } = await SpruikIap.initialize({ productIds: PRODUCT_IDS });
  return available;
}

export async function buy(productId: string, userId: string) {
  const { status, transaction } = await SpruikIap.purchase({ productId });
  if (status === 'purchased') await vend16.handle(transaction, userId, SpruikIap);
  return status; // 'cancelled' and 'pending' are normal, not errors
}

/** What this user can use. Ask the server, never the device. */
export async function unlocked(userId: string): Promise<Set<string>> {
  const { active_product_ids } = await vend16.subscriber(userId);
  return new Set(active_product_ids);
}

export async function restore(userId: string) {
  // Restored purchases were finished long ago: report them so they attach to
  // this user, but do not finish them again.
  const { transactions } = await SpruikIap.restore();
  for (const tx of transactions) await vend16.record(tx, userId).catch(() => {});
  return unlocked(userId);
}
```

- `userId` is the app's stable user ID (the auth user's ID). Never an email address, never a device ID.
- Find the real product IDs in the code, config or paywall. If there are none, ask the user for them and whether each is a consumable, a non-consumable or a subscription.
- Show prices from `SpruikIap.getProducts()` (they come localised from the store). Never hard-code prices.
- Give the paywall a Restore Purchases button that calls `restore`. Apple requires one.

## 4. The money rules (apply all of them)

1. **Finish only after Vend16 says yes.** `vend16.handle` calls `finish()` only when Vend16 replies `recorded`, `duplicate` or `revoked`. Never call `SpruikIap.finish` yourself before that.
2. **A network error or `502 store_unavailable` is not a failure.** Do not finish. The store redelivers the purchase on the next launch and the listener records it then. Tell the user "We could not confirm your purchase yet" rather than "failed".
3. **`422 invalid_receipt` means the store says it is not real.** `handle` finishes it so it stops coming back. Unlock nothing.
4. **Unlock from the server.** Gate features on `active_product_ids` from `vend16.subscriber(userId)`. Refresh it on app start, after a purchase and after restore. Never unlock from a local flag or from the purchase result alone.
5. **Consumables are consumed, everything else is acknowledged.** `handle` does this from `productTypes`. A wrong type on Android either makes a product buyable only once or gets a subscription refunded by Google after three days.

## 5. Tell the user what is left

Code alone is not enough. Finish your turn by listing what the user still has to do, with these exact places:

**App Store Connect**
- Create the products (Monetization, In-App Purchases or Subscriptions) with the same product IDs as the code.
- App Information, App Store Server Notifications: set **both** Production and Sandbox to `https://vend16.com/v1/notifications/apple/<APP_ID>` and choose Version 2. `<APP_ID>` is the Vend16 app ID (`app_...`).
- Test with a Sandbox account on a real iPhone (TestFlight or a debug build). Simulators cannot buy.

**Google Play Console**
- Create the products (Monetize with Play, Products) with the same IDs. The app must be uploaded to a testing track first.
- Give Vend16 a Google Play service account (JSON key) on the app's Setup page at https://vend16.com/app, so it can check purchases. The Setup page walks through it.
- For renewals and refunds, turn on Real-time developer notifications with the Pub/Sub details from the Setup page.
- Test with a licence tester account (Play Console, Settings, License testing).

If you have Vend16 tools, `setup_status` returns this checklist with what is already done ticked off. The CLI prints it too: `npx github:spruikco/vend16-cli status`.

## 6. Check your work

- `npx cap sync` ran without errors and the plugin is listed for both platforms.
- The listener is added before `initialize`, once per app run.
- No secret key (`sk_`) anywhere in the app, the repo or your messages.
- Every unlock reads from `active_product_ids`.

## Without Vend16

If the user wants their own backend, `server/` in this repo has offline Apple JWS verification pinned to Apple's root and a Google Play Developer API client, and `examples/nextjs/` shows the routes of a shipped app. The money rules are the same: verify on the server, grant, then `finish()`.

## Help

Docs: https://vend16.com/docs. Agent guide: https://vend16.com/llms-full.txt. Email: hello@spruik.co.
