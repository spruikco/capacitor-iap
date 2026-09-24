'use strict';

// CommonJS build. See dist/esm/index.js for why these are hand-written.
Object.defineProperty(exports, '__esModule', { value: true });

const core = require('@capacitor/core');

const SpruikIap = core.registerPlugin('SpruikIap', {
  web: async () => {
    // See the ESM build for the reasoning: no fake purchases in a browser.
    return new (class extends core.WebPlugin {
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

exports.SpruikIap = SpruikIap;
