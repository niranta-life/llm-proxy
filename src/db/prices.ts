import type { Pool } from 'pg';
import { canonicalDecimal } from '../inference/cost.js';

export type RegisteredPrice = {
  id: string;
  verificationStatus: string;
  effectiveAt: string;
};

export type ReconciledCost = {
  costStatus: string;
  amount: string | null;
  allocatedStatus: string | null;
  allocatedAmount: string | null;
  priceVersionId: string | null;
};

function stamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function money(value: string | null): string | null {
  return value === null ? null : canonicalDecimal(value);
}

export async function registerPrice(
  pool: Pool,
  input: {
    provider: string;
    model: string;
    region: string | null;
    serviceTier: string | null;
    servingProvider: string | null;
    effectiveAt: string;
    priceSource: string;
    verificationStatus: string;
    inputRate: string | null;
    outputRate: string | null;
    cacheReadRate: string | null;
    cacheWriteRate: string | null;
    thinkingRate: string | null;
    requestFee: string | null;
    allocatedRate: string | null;
  },
): Promise<RegisteredPrice> {
  const result = await pool.query<{ id: string; verification_status: string; effective_at: Date | string }>(
    `SELECT id, verification_status, effective_at
     FROM insert_price_version($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      input.provider,
      input.model,
      input.region,
      input.serviceTier,
      input.servingProvider,
      input.effectiveAt,
      input.priceSource,
      input.verificationStatus,
      input.inputRate,
      input.outputRate,
      input.cacheReadRate,
      input.cacheWriteRate,
      input.thinkingRate,
      input.requestFee,
      input.allocatedRate,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('price was not stored');
  return {
    id: row.id,
    verificationStatus: row.verification_status,
    effectiveAt: stamp(row.effective_at),
  };
}

export async function setDeploymentServiceTier(
  pool: Pool,
  tenantId: string,
  name: string,
  serviceTier: string | null,
): Promise<string | null> {
  const result = await pool.query<{ service_tier: string | null }>(
    `SELECT set_deployment_service_tier($1, $2, $3) AS service_tier`,
    [tenantId, name, serviceTier],
  );
  return result.rows[0]?.service_tier ?? null;
}

export async function reconcileAttemptCost(pool: Pool, tenantId: string, attemptId: string): Promise<ReconciledCost> {
  const result = await pool.query<{
    cost_status: string;
    amount: string | null;
    allocated_status: string | null;
    allocated_amount: string | null;
    price_version_id: string | null;
  }>(
    `SELECT cost_status, amount::text AS amount, allocated_status,
            allocated_amount::text AS allocated_amount, price_version_id
     FROM reconcile_attempt_cost($1, $2)`,
    [tenantId, attemptId],
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error('cost is missing');
  return {
    costStatus: row.cost_status,
    amount: money(row.amount),
    allocatedStatus: row.allocated_status,
    allocatedAmount: money(row.allocated_amount),
    priceVersionId: row.price_version_id,
  };
}
