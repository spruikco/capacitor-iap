import { registerPlugin } from '@capacitor/core';

import type { SpruikIapPlugin } from './definitions';

/**
 * 'SpruikIap' must match the identifier the native side registers:
 *   iOS      `identifier`/`jsName` in IapPlugin.swift's CAPBridgedPlugin conformance
 *   Android  @CapacitorPlugin(name = "SpruikIap")
 *
 * It is also the key the plugin appears under on `window.Capacitor.Plugins`,
 * which is how a remotely-served web app (one loaded from your domain rather
 * than bundled) can reach it without an npm dependency on this package.
 */
const SpruikIap = registerPlugin<SpruikIapPlugin>('SpruikIap', {
  web: () => import('./web').then((m) => new m.SpruikIapWeb()),
});

export * from './definitions';
export { SpruikIap };
