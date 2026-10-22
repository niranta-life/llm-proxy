import type { Pool, PoolClient } from 'pg';
import { canonicalDecimal, type PriceCandidate } from '../inference/cost.js';
import { withTenant } from './tenant-context.js';

export type AdmitDecision = {
  decision: string;
  reason: string;
};

type PriceRow = {
  id: string;
  provider: string;
  model: string;
  region: string | null;
  service_tier: string | null;
  serving_provider: string | null;
  effective_at: Date | string;
  created_at: Date | string;
  price_source: string;
  verification_status: string;
  currency: string;
  input_rate: string | null;
  output_rate: string | null;
  cache_read_rate: string | null;
  cache_write_rate: string | null;
  thinking_rate: string | null;
  request_fee: string | null;
  allocated_rate: string | null;
};

type CapacityRow = {
  requests_in_window: string | number;
  tokens_in_window: string | number;
  concurrent_requests: string | number;
  concurrent_streams: string | number;
  reserved_concurrency: string | number;
  allocated: string | null;
  recognized: string | null;
  active_reservations: string | null;
  provisional: string | null;
  available: string | null;
  unknown_charges: string | number;
  budget_mode: string | null;
  limit_mode: string | null;
  currency: string | null;
  cost_status: string | null;
};

type LimitRow = {
  mode: string;
  requests_per_minute: number | null;
  concurrent_requests: number | null;
  concurrent_streams: number | null;
  token_rate_per_minute: string | number | null;
  lease_ms: number;
};

type KeyLimitRow = {
  api_key_id: string;
  mode: string | null;
  requests_per_minute: number | null;
  concurrent_requests: number | null;
  concurrent_streams: number | null;
  token_rate_per_minute: string | number | null;
};

type ConnectionLimitRow = {
  provider: string;
  mode: string;
  max_concurrency: number;
  share_group: string | null;
};

type DeploymentLimitRow = {
  name: string;
  mode: string;
  max_concurrency: number;
};

export type CapacityReport = {
  configuredLimits: {
    mode: string | null;
    requestsPerMinute: number | null;
    concurrentRequests: number | null;
    concurrentStreams: number | null;
    tokenRatePerMinute: number | null;
    leaseMs: number | null;
    apiKeys: Array<{
      apiKeyId: string;
      mode: string | null;
      requestsPerMinute: number | null;
      concurrentRequests: number | null;
      concurrentStreams: number | null;
      tokenRatePerMinute: number | null;
    }>;
    connections: Array<{
      provider: string;
      mode: string;
      maxConcurrency: number;
      shareGroup: string | null;
    }>;
    deployments: Array<{
      deployment: string;
      mode: string;
      maxConcurrency: number;
    }>;
  };
  observedUsage: {
    requestsInWindow: string;
    tokensInWindow: string;
    concurrentRequests: string;
    concurrentStreams: string;
  };
  reservedCapacity: {
    concurrency: string;
    activeReservations: string | null;
    provisional: string | null;
    unknownCharges: string;
  };
  remainingBudget: string | null;
  costStatus: string;
  budget: {
    mode: string | null;
    currency: string | null;
    allocated: string | null;
    recognized: string | null;
    activeReservations: string | null;
    provisional: string | null;
    available: string | null;
    unknownCharges: string;
  };
};

function stamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function money(value: string | null): string | null {
  return value === null ? null : canonicalDecimal(value);
}

function countText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '0';
  return String(value);
}

function countOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function priceFromRow(row: PriceRow): PriceCandidate {
  if (row.verification_status !== 'verified' && row.verification_status !== 'unverified') {
    throw new Error('price verification is invalid');
  }
  if (row.currency !== 'USD') throw new Error('price currency is invalid');
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    region: row.region,
    serviceTier: row.service_tier,
    servingProvider: row.serving_provider,
    effectiveAt: stamp(row.effective_at),
    createdAt: stamp(row.created_at),
    priceSource: row.price_source,
    verificationStatus: row.verification_status,
    currency: 'USD',
    inputRate: money(row.input_rate),
    outputRate: money(row.output_rate),
    cacheReadRate: money(row.cache_read_rate),
    cacheWriteRate: money(row.cache_write_rate),
    thinkingRate: money(row.thinking_rate),
    requestFee: money(row.request_fee),
    allocatedRate: money(row.allocated_rate),
  };
}

export async function loadDeploymentServiceTier(
  client: PoolClient,
  tenantId: string,
  deploymentId: string,
): Promise<string | null> {
  const result = await client.query<{ service_tier: string | null }>(
    'SELECT service_tier FROM model_deployments WHERE tenant_id = $1 AND id = $2',
    [tenantId, deploymentId],
  );
  return result.rows[0]?.service_tier ?? null;
}

export async function loadAdmissionPrices(
  client: PoolClient,
  provider: string,
  model: string,
  at: Date,
): Promise<PriceCandidate[]> {
  const prices = await client.query<PriceRow>(
    `SELECT id, provider, model, region, service_tier, serving_provider, effective_at, created_at, price_source,
            verification_status, currency,
            input_rate::text AS input_rate, output_rate::text AS output_rate,
            cache_read_rate::text AS cache_read_rate, cache_write_rate::text AS cache_write_rate,
            thinking_rate::text AS thinking_rate, request_fee::text AS request_fee,
            allocated_rate::text AS allocated_rate
     FROM price_versions
     WHERE provider = $1 AND model = $2 AND effective_at <= $3`,
    [provider, model, at],
  );
  return prices.rows.map(priceFromRow);
}

export async function admitAttempt(
  client: PoolClient,
  input: {
    tenantId: string;
    apiKeyId: string;
    connectionId: string;
    deploymentId: string;
    attemptId: string;
    stream: boolean;
    now: Date;
    windowStart: Date;
    periodStart: string;
    tokenBound: number | null;
    estimate: string | null;
    estimateKind: 'bounded' | 'unbounded' | 'unknown';
    priceVersionId: string | null;
  },
): Promise<AdmitDecision> {
  const result = await client.query<{ decision: string; reason: string }>(
    `SELECT decision, reason
     FROM admit_attempt($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10, $11::numeric, $12, $13)`,
    [
      input.tenantId,
      input.apiKeyId,
      input.connectionId,
      input.deploymentId,
      input.attemptId,
      input.stream,
      input.now,
      input.windowStart,
      input.periodStart,
      input.tokenBound,
      input.estimate,
      input.estimateKind,
      input.priceVersionId,
    ],
  );
  const row = result.rows[0];
  if (row === undefined) return { decision: 'reject', reason: 'admission_unavailable' };
  return row;
}

export async function closeAttemptAdmission(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
  now: Date,
): Promise<string> {
  const result = await client.query<{ close_attempt_admission: string }>(
    'SELECT close_attempt_admission($1, $2, $3) AS close_attempt_admission',
    [tenantId, attemptId, now],
  );
  return result.rows[0]?.close_attempt_admission ?? 'closed';
}

export async function readTenantCapacity(pool: Pool, tenantId: string, now: Date): Promise<CapacityReport> {
  return withTenant(pool, tenantId, async (client) => {
    const window = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    const period = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const capacity = await client.query<CapacityRow>(
      `SELECT requests_in_window, tokens_in_window, concurrent_requests, concurrent_streams, reserved_concurrency,
              allocated::text AS allocated, recognized::text AS recognized,
              active_reservations::text AS active_reservations, provisional::text AS provisional,
              available::text AS available, unknown_charges, budget_mode, limit_mode, currency, cost_status
       FROM read_tenant_capacity($1, $2, $3, $4::date)`,
      [tenantId, now, window, period],
    );
    const row = capacity.rows[0];
    if (row === undefined) throw new Error('capacity is missing');
    const limits = await client.query<LimitRow>(
      `SELECT mode, requests_per_minute, concurrent_requests, concurrent_streams,
              token_rate_per_minute, lease_ms
       FROM tenant_limit_policies
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const keys = await client.query<KeyLimitRow>(
      `SELECT api_key_id, mode, requests_per_minute, concurrent_requests, concurrent_streams, token_rate_per_minute
       FROM api_key_limit_policies
       WHERE tenant_id = $1
       ORDER BY api_key_id`,
      [tenantId],
    );
    const connections = await client.query<ConnectionLimitRow>(
      `SELECT c.provider, p.mode, p.max_concurrency, p.share_group
       FROM connection_limit_policies p
       JOIN provider_connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
       WHERE p.tenant_id = $1
       ORDER BY c.provider`,
      [tenantId],
    );
    const deployments = await client.query<DeploymentLimitRow>(
      `SELECT d.name, p.mode, p.max_concurrency
       FROM deployment_limit_policies p
       JOIN model_deployments d ON d.tenant_id = p.tenant_id AND d.id = p.deployment_id
       WHERE p.tenant_id = $1
       ORDER BY d.name`,
      [tenantId],
    );
    const policy = limits.rows[0];
    const available = money(row.available);
    return {
      configuredLimits: {
        mode: policy?.mode ?? null,
        requestsPerMinute: policy?.requests_per_minute ?? null,
        concurrentRequests: policy?.concurrent_requests ?? null,
        concurrentStreams: policy?.concurrent_streams ?? null,
        tokenRatePerMinute: countOrNull(policy?.token_rate_per_minute),
        leaseMs: policy?.lease_ms ?? null,
        apiKeys: keys.rows.map((key) => ({
          apiKeyId: key.api_key_id,
          mode: key.mode,
          requestsPerMinute: key.requests_per_minute,
          concurrentRequests: key.concurrent_requests,
          concurrentStreams: key.concurrent_streams,
          tokenRatePerMinute: countOrNull(key.token_rate_per_minute),
        })),
        connections: connections.rows.map((connection) => ({
          provider: connection.provider,
          mode: connection.mode,
          maxConcurrency: connection.max_concurrency,
          shareGroup: connection.share_group,
        })),
        deployments: deployments.rows.map((deployment) => ({
          deployment: deployment.name,
          mode: deployment.mode,
          maxConcurrency: deployment.max_concurrency,
        })),
      },
      observedUsage: {
        requestsInWindow: countText(row.requests_in_window),
        tokensInWindow: countText(row.tokens_in_window),
        concurrentRequests: countText(row.concurrent_requests),
        concurrentStreams: countText(row.concurrent_streams),
      },
      reservedCapacity: {
        concurrency: countText(row.reserved_concurrency),
        activeReservations: money(row.active_reservations),
        provisional: money(row.provisional),
        unknownCharges: countText(row.unknown_charges),
      },
      remainingBudget: available,
      costStatus: row.cost_status ?? 'none',
      budget: {
        mode: row.budget_mode,
        currency: row.currency,
        allocated: money(row.allocated),
        recognized: money(row.recognized),
        activeReservations: money(row.active_reservations),
        provisional: money(row.provisional),
        available,
        unknownCharges: countText(row.unknown_charges),
      },
    };
  });
}

export async function setTenantLimits(
  pool: Pool,
  tenantId: string,
  mode: string,
  requestsPerMinute: number | null,
  concurrentRequests: number | null,
  concurrentStreams: number | null,
  tokenRatePerMinute: number | null,
  leaseMs: number | null,
): Promise<void> {
  await pool.query('SELECT set_tenant_limits($1, $2, $3, $4, $5, $6, $7)', [
    tenantId,
    mode,
    requestsPerMinute,
    concurrentRequests,
    concurrentStreams,
    tokenRatePerMinute,
    leaseMs,
  ]);
}

export async function setApiKeyLimits(
  pool: Pool,
  tenantId: string,
  apiKeyId: string,
  mode: string | null,
  requestsPerMinute: number | null,
  concurrentRequests: number | null,
  concurrentStreams: number | null,
  tokenRatePerMinute: number | null,
): Promise<void> {
  await pool.query('SELECT set_api_key_limits($1, $2, $3, $4, $5, $6, $7)', [
    tenantId,
    apiKeyId,
    mode,
    requestsPerMinute,
    concurrentRequests,
    concurrentStreams,
    tokenRatePerMinute,
  ]);
}

export async function setConnectionLimit(
  pool: Pool,
  tenantId: string,
  provider: string,
  mode: string,
  maxConcurrency: number | null,
  shareGroup: string | null,
): Promise<void> {
  await pool.query('SELECT set_connection_limit($1, $2, $3, $4, $5)', [
    tenantId,
    provider,
    mode,
    maxConcurrency,
    shareGroup,
  ]);
}

export async function setDeploymentLimit(
  pool: Pool,
  tenantId: string,
  deployment: string,
  mode: string,
  maxConcurrency: number | null,
): Promise<void> {
  await pool.query('SELECT set_deployment_limit($1, $2, $3, $4)', [tenantId, deployment, mode, maxConcurrency]);
}

export async function setTenantBudget(pool: Pool, tenantId: string, mode: string, monthlyAmount: string): Promise<void> {
  await pool.query('SELECT set_tenant_budget($1, $2, $3)', [tenantId, mode, monthlyAmount]);
}

export async function recoverTenantBudget(pool: Pool, tenantId: string, now: Date): Promise<number> {
  return withTenant(pool, tenantId, async (client) => {
    const result = await client.query<{ recover_tenant_budget: number }>(
      'SELECT recover_tenant_budget($1, $2) AS recover_tenant_budget',
      [tenantId, now],
    );
    return Number(result.rows[0]?.recover_tenant_budget ?? 0);
  });
}
