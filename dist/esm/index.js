// Hand-written on purpose — see README.md. `src/` is the readable source;
// this file is committed so the CI image needs no plugin build step before
// `cap sync`. The surface is small enough that a rollup/tsc toolchain would
// cost more (and add a way for the iOS build to fail) than it saves.
import { registerPlugin } from '@capacitor/core';

export const SpruikIap = registerPlugin('SpruikIap', {
  web: async () => {
    // No in-app purchase in a browser, and deliberately no fake one.
    // `available: false` tells callers to fall back to the web payment rail;
    // purchase() throws rather than resolving 'cancelled', so choosing the
    // wrong rail in a browser surfaces as a bug instead of looking like the
    // user changed their mind.
    const { WebPlugin } = await import('@capacitor/core');
    return new (class extends WebPlugin {
      async initialize() {
        return { available: false };
      }
      async getProducts() {
        return { products: [] };
      }
      async purchase() {
        throw this.unavailable(
          'In-app purchase is only available in the native app. Use the web payment rail in a browser.',
        );
      }
      async finish() {}
      async restore() {
        return { transactions: [] };
      }
      async getEntitlements() {
        return { entitlements: [] };
      }
    })();
  },
});
