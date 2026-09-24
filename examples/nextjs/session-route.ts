// EXAMPLE, not a drop-in. Lifted from a production Next.js app (App Router,
// drizzle + postgres, a credits ledger). Imports from '@/lib/...' are that
// app's own auth, database and ledger; replace them with yours. The shape of
// the flow and the comments are the part worth keeping.

import { randomUUID } from 'node:crypto';

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { requireAuth } from '@/lib/auth-helpers';
import { CREDIT_PACKS } from '@/lib/credits/packs';
import { db } from '@/server/db/client';

/**
 * Everything the native shell needs before it can open the store: the product
 * ids to load, and this manager's opaque store-side account token.
 *
 * The token is minted lazily on first use rather than at signup, so the column
 * stays empty for the (large) majority of managers who never open the app.
 *
 * ⚠️ It must be STABLE once issued. Both stores record it against the purchase
 * permanently, so re-rolling it would orphan every earlier purchase from its
 * owner — which is exactly the attribution this exists to provide. Hence
 * COALESCE rather than an unconditional UPDATE.
 */

function getRows<T>(result: unknown): T[] {
  return Array.isArray(result) ? result : (result as { rows: T[] }).rows || [];
}

export async function GET() {
  try {
    const { managerId } = await requireAuth();

    const result = await db.execute(sql`
      UPDATE managers
         SET app_account_token = COALESCE(app_account_token, ${randomUUID()}::uuid)
       WHERE id = ${managerId}
       RETURNING app_account_token
    `);

    const token = getRows<{ app_account_token: string }>(result)[0]?.app_account_token ?? null;

    return NextResponse.json({
      appAccountToken: token,
      // Product ids mirror lib/credits/packs.ts 1:1, so the catalogue has a
      // single source of truth and the app never hardcodes a second list.
      productIds: CREDIT_PACKS.map((pack) => `credits_${pack.id}`),
      enabled: {
        ios: process.env.APPLE_IAP_ENABLED === '1',
        android: process.env.GOOGLE_IAP_ENABLED === '1',
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('[iap] session failed:', error);
    return NextResponse.json({ error: 'Failed to start purchase session' }, { status: 500 });
  }
}
