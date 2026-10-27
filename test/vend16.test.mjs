// The money rules in createVend16().handle, against a fake fetch.
// Run: npm test (Node 20+).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVend16 } from '../dist/esm/vend16.js';

function fakeFetch(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return calls;
}

function fakePlugin() {
  const finished = [];
  return { finished, finish: async (o) => { finished.push(o); } };
}

const tx = (productId, platform = 'android') => ({ productId, platform, token: 'tok_' + productId, transactionId: 'GPA.1', unsolicited: false });

test('only a public key is accepted', () => {
  assert.throws(() => createVend16({ apiKey: 'sk_live_x' }), /PUBLIC key/);
  assert.throws(() => createVend16({}), /PUBLIC key/);
});

test('recorded: reports the purchase, then consumes a consumable', async () => {
  const calls = fakeFetch(200, { status: 'recorded', purchase: {}, subscriber: {} });
  const plugin = fakePlugin();
  const v = createVend16({ apiKey: 'pk_test', baseUrl: 'https://example.test' });
  const r = await v.handle(tx('coins_100'), 'user_1', plugin);
  assert.equal(r.status, 'recorded');
  assert.equal(calls[0].url, 'https://example.test/v1/receipts');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer pk_test');
  assert.deepEqual(calls[0].body, { platform: 'android', token: 'tok_coins_100', productId: 'coins_100', productType: 'consumable', appUserId: 'user_1' });
  assert.deepEqual(plugin.finished, [{ transactionId: 'GPA.1', consume: true }]);
});

test('duplicate: a subscription is acknowledged, not consumed', async () => {
  fakeFetch(200, { status: 'duplicate' });
  const plugin = fakePlugin();
  const v = createVend16({ apiKey: 'pk_test', productTypes: { pro_monthly: 'subscription' } });
  await v.handle(tx('pro_monthly'), 'user_1', plugin);
  assert.deepEqual(plugin.finished, [{ transactionId: 'GPA.1', consume: false }]);
});

test('502 store_unavailable: nothing is finished, so the store redelivers', async () => {
  fakeFetch(502, { error: { code: 'store_unavailable', message: 'Google did not answer' } });
  const plugin = fakePlugin();
  const v = createVend16({ apiKey: 'pk_test' });
  await assert.rejects(v.handle(tx('coins_100'), 'user_1', plugin), (e) => e.status === 502 && e.code === 'store_unavailable');
  assert.equal(plugin.finished.length, 0);
});

test('a network error: nothing is finished', async () => {
  globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
  const plugin = fakePlugin();
  const v = createVend16({ apiKey: 'pk_test' });
  await assert.rejects(v.handle(tx('coins_100'), 'user_1', plugin));
  assert.equal(plugin.finished.length, 0);
});

test('422 invalid_receipt: finished without consuming, and the error still surfaces', async () => {
  fakeFetch(422, { error: { code: 'invalid_receipt', message: 'Not a real purchase' } });
  const plugin = fakePlugin();
  const v = createVend16({ apiKey: 'pk_test' });
  await assert.rejects(v.handle(tx('coins_100'), 'user_1', plugin), (e) => e.code === 'invalid_receipt');
  assert.deepEqual(plugin.finished, [{ transactionId: 'GPA.1', consume: false }]);
});

test('pending: not finished yet', async () => {
  fakeFetch(200, { status: 'pending' });
  const plugin = fakePlugin();
  const v = createVend16({ apiKey: 'pk_test' });
  await v.handle(tx('coins_100'), 'user_1', plugin);
  assert.equal(plugin.finished.length, 0);
});

test('subscriber: asks the server, with the user ID encoded', async () => {
  const calls = fakeFetch(200, { app_user_id: 'a b', active_product_ids: ['pro_monthly'] });
  const v = createVend16({ apiKey: 'pk_test' });
  const s = await v.subscriber('a b');
  assert.deepEqual(s.active_product_ids, ['pro_monthly']);
  assert.equal(calls[0].url, 'https://vend16.com/v1/subscribers/a%20b');
});
