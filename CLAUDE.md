# CLAUDE.md

Adding in-app purchases to an app with this plugin? Read and follow [AGENTS.md](AGENTS.md). It is the single source of instructions for coding agents, Claude included.

Working on the plugin itself:

- `dist/` is committed and hand-written. Keep `src/` and `dist/` in step by hand (there is no build step on purpose).
- The npm name `@spruik/capacitor-iap` decides the Swift package name `SpruikCapacitorIap`. Never rename one without the other.
- iOS is StoreKit 2 in Swift (`ios/Sources/IapPlugin`), Android is Play Billing in Java (`android/`).
- No em dashes in docs. Plain English.
