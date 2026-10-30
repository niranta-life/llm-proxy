import type { Pool } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import { runAutomaticPromotion } from './promotion-store.js';

export async function runPromotionPass(pool: Pool, tenantIds: readonly string[]): Promise<{ promoted: number }> {
  let promoted = 0;
  for (const tenantId of tenantIds) {
    const result = await withTenant(pool, tenantId, (client) => runAutomaticPromotion(client, tenantId));
    if (result.promoted) promoted += 1;
  }
  return { promoted };
}
