# @spruik/capacitor-iap

In-app purchases for Capacitor 8. StoreKit 2 on iOS, Play Billing on Android,
behind one JavaScript interface. Consumables and subscriptions.

Built by [Spruik](https://spruik.co) for a live football-management game with
paid credit packs, and structured as a standalone package from day one.

## What is in this repo

| Path | What |
|---|---|
| `src/`, `ios/`, `android/`, `dist/` | The Capacitor plugin: `@spruik/capacitor-iap`. StoreKit 2 (Swift) and Play Billing (Java) behind one TypeScript interface. |
| `server/` | `@spruik/capacitor-iap-server`: offline Apple JWS verification pinned to Apple's root, and a Play Developer API client. No dependencies. Attack-focused test suite. |
| `examples/nextjs/` | The server side of a shipped app: verify route, session route, both store notification endpoints, the SQL. |

## Why it exists

There is no maintained, SPM-native Capacitor IAP plugin.
`@capacitor-community/in-app-purchases` does not exist, `capacitor-plugin-purchase`
is abandoned at 0.1.0, and `cordova-plugin-purchase` is a Cordova plugin whose
template Capacitor 8 has hardcoded away from — dropping it into an SPM project
produces an unreadable `App.xcodeproj`.

## Design

**The client is never trusted.** A purchase is real only once your server has
verified it with Apple or Google:

```
purchase() → POST the token to your server → server verifies → server grants → finish()
```

`finish()` only after the server confirms. Until then both stores keep
re-delivering the transaction, so a failed verification is a retry rather than a
player who paid and got nothing.

**Platform differences are pushed into the native code**, except one that cannot
honestly be hidden: `IapTransaction.token` is a signed JWS on iOS (verify it
offline against Apple's root) and an opaque purchase token on Android (exchange
it with the Play Developer API).

## Install

```jsonc
// mobile/package.json
"dependencies": {
  "@spruik/capacitor-iap": "file:packages/capacitor-iap"
}
```

Then `npx cap sync`. No further wiring: `cap sync` finds the `Package.swift` and
adds it to `CapApp-SPM/Package.swift` automatically, and adds the Gradle module
on Android.

⚠️ The npm package name determines the Swift package name. Capacitor computes
`fixName('@spruik/capacitor-iap')` → `SpruikCapacitorIap` and writes that into
the generated `Package.swift`, so **the package name and the library product
name in `Package.swift` must both be exactly that string.** Renaming the npm
package without renaming both breaks the iOS build on the build machine only.

## API

See `src/definitions.ts` — it carries the reasoning, not just the types.

```ts
await SpruikIap.addListener('transactionUpdated', handle); // BEFORE initialize
const { available } = await SpruikIap.initialize({ productIds });
const { products }  = await SpruikIap.getProducts();
const { status, transaction } = await SpruikIap.purchase({ productId, appAccountToken });
await SpruikIap.finish({ transactionId, consume: true });  // consumables consume
```

Attach the listener **before** `initialize`: both stores flush queued
transactions on connect, and a listener attached afterwards misses them.

`consume: true` for consumables, `false` (acknowledge) for subscriptions.
Backwards on Android means either a product buyable exactly once, or a
subscription Google refunds after three days.

## Notes

- **iOS 15+** (StoreKit 2). Matches the Capacitor 8 app template.
- **Java, not Kotlin**, on Android: the Capacitor template puts no Kotlin plugin
  on the buildscript classpath, and a Kotlin toolchain is one more thing that
  can only fail on CI.
- **`dist/` is committed and hand-written.** The surface is tiny, the consuming
  app reaches the plugin through the Capacitor bridge rather than importing it,
  and a build step here would be one more way for an iOS build to fail. `src/`
  is the readable source; keep the two in step by hand.

## Licence

MIT.
