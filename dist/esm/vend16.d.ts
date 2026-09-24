import type { IapTransaction, SpruikIapPlugin } from './index';
export interface Vend16Options {
  /** Your PUBLIC key (pk_...). Free at https://vend16.com/signup */
  apiKey: string;
  baseUrl?: string;
  /** Map productId to 'consumable' | 'non_consumable' | 'subscription' where the name alone doesn't say. */
  productTypes?: Record<string, string>;
}
export interface Vend16 {
  record(tx: IapTransaction, appUserId: string, price?: { micros: number; currency: string }): Promise<any>;
  handle(tx: IapTransaction | null, appUserId: string, plugin: Pick<SpruikIapPlugin, 'finish'>, price?: { micros: number; currency: string }): Promise<any>;
  subscriber(appUserId: string): Promise<{ app_user_id: string; active_product_ids: string[]; subscriptions: any[]; non_consumables: any[]; recent_one_time_purchases: any[] }>;
}
export declare function createVend16(options: Vend16Options): Vend16;
