// Vend16 client for apps. Framework-agnostic ESM, no dependencies.
//
// With @spruik/capacitor-iap:
//
//   import { SpruikIap } from '@spruik/capacitor-iap';
//   import { createVend16 } from './vend16-client.js';
//
//   const vend16 = createVend16({ apiKey: 'pk_...' });
//   const userId = currentUser.id;
//
//   // 1. Listener BEFORE initialize: stores flush queued transactions on connect.
//   await SpruikIap.addListener('transactionUpdated', (tx) => vend16.handle(tx, userId, SpruikIap));
//   await SpruikIap.initialize({ productIds: ['coins_100', 'pro_monthly'] });
//
//   // 2. Buy
//   const { status, transaction } = await SpruikIap.purchase({ productId: 'coins_100', appAccountToken: userUuid });
//   if (status === 'purchased') await vend16.handle(transaction, userId, SpruikIap);
//
//   // 3. Gate features on the server's answer, never the device's
//   const { active_product_ids } = await vend16.subscriber(userId);
//
// `handle` only calls finish() after Vend16 has verified and recorded the
// purchase. If the network drops, the store re-delivers on next launch.

const CONSUMABLE_HINT = /coin|credit|gem|token|pack|consumable/i;

export function createVend16({ apiKey, baseUrl = 'https://vend16.com', productTypes = {} } = {}) {
  if (!apiKey || !apiKey.startsWith('pk_')) throw new Error('Vend16: pass your PUBLIC key (pk_...) to the client');
  const call = async (method, path, body) => {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json?.error?.message || `Vend16 HTTP ${res.status}`);
      err.code = json?.error?.code;
      err.status = res.status;
      throw err;
    }
    return json;
  };

  const typeOf = (productId) =>
    productTypes[productId] || (CONSUMABLE_HINT.test(productId) ? 'consumable' : undefined);

  return {
    /** Report a transaction to Vend16. Returns { status, purchase, subscriber }. */
    record(tx, appUserId, price) {
      return call('POST', '/v1/receipts', {
        platform: tx.platform,
        token: tx.token,
        productId: tx.productId,
        productType: typeOf(tx.productId),
        appUserId,
        price,
      });
    },

    /**
     * Record, then finish with the store only once Vend16 has accepted it.
     * Pass the plugin so this stays decoupled from any one IAP library.
     */
    async handle(tx, appUserId, plugin, price) {
      if (!tx) return null;
      try {
        const result = await this.record(tx, appUserId, price);
        if (result.status === 'recorded' || result.status === 'duplicate' || result.status === 'revoked') {
          await plugin.finish({ transactionId: tx.transactionId, consume: typeOf(tx.productId) === 'consumable' });
        }
        return result;
      } catch (e) {
        // 422 means the store says it is not a real purchase: finish so it stops re-delivering.
        if (e.status === 422) await plugin.finish({ transactionId: tx.transactionId, consume: false }).catch(() => {});
        throw e;
      }
    },

    /** Entitlements for a user, as the server sees them. */
    subscriber(appUserId) {
      return call('GET', `/v1/subscribers/${encodeURIComponent(appUserId)}`);
    },
  };
}
