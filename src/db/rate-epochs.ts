import type { Pool, PoolClient } from 'pg';
import type { RateLimitSnapshot } from '../redis/hot-counters.js';
import { RATE_SCOPES, type RateScope } from '../redis/active-quota.js';

export type SliceRow = {
  outcome: 'spend' | 'seed' | 'deny' | 'inactive';
  reason: string;
  epoch: number | null;
  allocated: number | null;
  seeded: boolean;
  version: number | null;
  generation: number | null;
  policyRevision: string | null;
};

type SliceSql = {
  outcome: string;
  reason: string;
  epoch: number | null;
  allocated: string | number | null;
  seeded: boolean;
  version: number | null;
  generation: number | null;
  policy_revision: string | null;
};

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function asOutcome(value: string): SliceRow['outcome'] {
  if (value === 'spend' || value === 'seed' || value === 'deny' || value === 'inactive') return value;
  return 'deny';
}

export function isRateScope(value: string): value is RateScope {
  return (RATE_SCOPES as readonly string[]).includes(value);
}

export async function activateRateBackend(
  pool: Pool,
  tenantId: string,
  scope: RateScope,
  scopeId: string,
  now: Date,
): Promise<number> {
  const result = await pool.query<{ activate_rate_backend: number }>(
    'SELECT activate_rate_backend($1, $2, $3, $4) AS activate_rate_backend',
    [tenantId, scope, scopeId, now],
  );
  return result.rows[0]?.activate_rate_backend ?? 0;
}

export async function deactivateRateBackend(
  pool: Pool,
  tenantId: string,
  scope: RateScope,
  scopeId: string,
  now: Date,
): Promise<number> {
  const result = await pool.query<{ deactivate_rate_backend: number }>(
    'SELECT deactivate_rate_backend($1, $2, $3, $4) AS deactivate_rate_backend',
    [tenantId, scope, scopeId, now],
  );
  return result.rows[0]?.deactivate_rate_backend ?? 0;
}

export async function allocateRateSlice(
  client: PoolClient,
  input: {
    tenantId: string;
    scope: RateScope;
    scopeId: string;
    windowStart: Date;
    cost: number;
    now: Date;
  },
): Promise<SliceRow> {
  const result = await client.query<SliceSql>(
    `SELECT outcome, reason, epoch, allocated, seeded, version, generation, policy_revision
     FROM allocate_rate_slice($1, $2, $3, $4, $5, $6)`,
    [input.tenantId, input.scope, input.scopeId, input.windowStart, input.cost, input.now],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return {
      outcome: 'deny',
      reason: 'bad_request',
      epoch: null,
      allocated: null,
      seeded: false,
      version: null,
      generation: null,
      policyRevision: null,
    };
  }
  return {
    outcome: asOutcome(row.outcome),
    reason: row.reason,
    epoch: row.epoch,
    allocated: numberOrNull(row.allocated),
    seeded: row.seeded,
    version: row.version,
    generation: row.generation,
    policyRevision: row.policy_revision,
  };
}

export async function markRateSliceSeeded(
  client: PoolClient,
  input: {
    tenantId: string;
    scope: RateScope;
    scopeId: string;
    windowStart: Date;
    epoch: number;
    version: number;
  },
): Promise<boolean> {
  const result = await client.query<{ mark_rate_slice_seeded: boolean }>(
    'SELECT mark_rate_slice_seeded($1, $2, $3, $4, $5, $6) AS mark_rate_slice_seeded',
    [input.tenantId, input.scope, input.scopeId, input.windowStart, input.epoch, input.version],
  );
  return result.rows[0]?.mark_rate_slice_seeded === true;
}

export async function closeRateSlice(
  client: PoolClient,
  input: {
    tenantId: string;
    scope: RateScope;
    scopeId: string;
    windowStart: Date;
    epoch: number;
    now: Date;
  },
): Promise<boolean> {
  const result = await client.query<{ close_rate_slice: boolean }>(
    'SELECT close_rate_slice($1, $2, $3, $4, $5, $6) AS close_rate_slice',
    [input.tenantId, input.scope, input.scopeId, input.windowStart, input.epoch, input.now],
  );
  return result.rows[0]?.close_rate_slice === true;
}

export async function closeOpenRateEpochs(pool: Pool, now: Date): Promise<number> {
  const result = await pool.query<{ close_open_rate_epochs: number }>(
    'SELECT close_open_rate_epochs($1) AS close_open_rate_epochs',
    [now],
  );
  return Number(result.rows[0]?.close_open_rate_epochs ?? 0);
}

export async function loadRateContext(
  client: PoolClient,
  tenantId: string,
  apiKeyId: string,
): Promise<{ limits: RateLimitSnapshot; activations: Array<{ scope: RateScope; scopeId: string }> }> {
  const tenant = await client.query<{
    mode: string;
    requests_per_minute: number | null;
    token_rate_per_minute: string | null;
  }>(
    `SELECT mode, requests_per_minute, token_rate_per_minute::text AS token_rate_per_minute
     FROM tenant_limit_policies WHERE tenant_id = $1`,
    [tenantId],
  );
  const key = await client.query<{
    mode: string | null;
    requests_per_minute: number | null;
    token_rate_per_minute: string | null;
  }>(
    `SELECT mode, requests_per_minute, token_rate_per_minute::text AS token_rate_per_minute
     FROM api_key_limit_policies WHERE tenant_id = $1 AND api_key_id = $2`,
    [tenantId, apiKeyId],
  );
  const activations = await client.query<{ scope: string; scope_id: string }>(
    `SELECT scope, scope_id
     FROM rate_backend_activations
     WHERE tenant_id = $1
       AND (
         (scope IN ('tenant_requests', 'tenant_tokens') AND scope_id = $1)
         OR (scope IN ('api_key_requests', 'api_key_tokens') AND scope_id = $2)
       )`,
    [tenantId, apiKeyId],
  );
  const tenantRow = tenant.rows[0];
  const keyRow = key.rows[0];
  return {
    limits: {
      tenantMode: tenantRow?.mode ?? null,
      tenantRequestsPerMinute: limitNumber(tenantRow?.requests_per_minute),
      tenantTokensPerMinute: limitNumber(tenantRow?.token_rate_per_minute),
      apiKeyMode: keyRow?.mode ?? null,
      apiKeyRequestsPerMinute: limitNumber(keyRow?.requests_per_minute),
      apiKeyTokensPerMinute: limitNumber(keyRow?.token_rate_per_minute),
    },
    activations: activations.rows.flatMap((row) => {
      if (!isRateScope(row.scope)) return [];
      return [{ scope: row.scope, scopeId: row.scope_id }];
    }),
  };
}

function limitNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!/^\d+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return null;
  return parsed;
}
