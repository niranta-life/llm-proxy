import type { PoolClient } from 'pg';
import type { Logger } from '../logger.js';
import type { RegistryProviderName } from './contract.js';
import {
  addDecimal,
  calculateCost,
  canonicalDecimal,
  costToStore,
  selectPrice,
  type CalculatedCost,
  type CostStatus,
  type PriceCandidate,
  type StoredUsage,
} from './cost.js';
import { invalidRequest } from './errors.js';

function storedCertainty(value: string | null, amount: string | null): 'none' | 'uncertain' | 'known' | null {
  if (amount !== null) return 'known';
  if (value === 'none' || value === 'uncertain' || value === 'known') return value;
  return null;
}

const PROVIDERS = new Set(['openai', 'anthropic', 'vertex', 'xai', 'openrouter', 'dgx']);
const DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const STATUSES: CostStatus[] = ['estimated', 'provisional', 'reconciled', 'unknown'];

export type CostFilters = {
  provider: string | null;
  deployment: string | null;
  model: string | null;
};

export type CostAmount = {
  attempts: number;
  amount: string | null;
};

export type CostBucket = {
  estimated: CostAmount;
  provisional: CostAmount;
  reconciled: CostAmount;
  unknown: CostAmount;
  currency: 'USD' | null;
};

export type CostReport = {
  window: { from: string; to: string };
  external: CostBucket;
  dgxAllocated: CostBucket;
  byProvider: Array<{
    provider: string;
    deployment: string;
    model: string;
    external: CostBucket;
    dgxAllocated: CostBucket;
  }>;
};

type AttemptCostRow = {
  provider: string;
  model: string;
  location: string | null;
  service_tier: string | null;
  serving_provider: string | null;
  created_at: Date;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  uncached_input_tokens: number | null;
  cache_creation_input_tokens: number | null;
  cache_read_input_tokens: number | null;
  thoughts_tokens: number | null;
  expense_certainty: string | null;
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

type ExistingRow = {
  cost_status: CostStatus;
  amount: string | null;
  allocated_status: CostStatus | null;
  allocated_amount: string | null;
  price_version_id: string | null;
  currency: 'USD' | null;
};

type GroupRow = {
  provider: string;
  deployment: string;
  model: string;
  cost_status: CostStatus;
  attempts: number;
  amount: string | null;
};

function providerName(value: string): RegistryProviderName {
  if (
    value === 'openai' ||
    value === 'anthropic' ||
    value === 'vertex' ||
    value === 'xai' ||
    value === 'openrouter' ||
    value === 'dgx'
  ) {
    return value;
  }
  throw new Error('provider is invalid');
}

function stamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function money(value: string | null): string | null {
  return value === null ? null : canonicalDecimal(value);
}

function count(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return value;
  if (/^(?:0|[1-9]\d*)$/.test(value)) return Number(value);
  return Number.NaN;
}

function optionalFilter(value: unknown, name: string, valid: (text: string) => boolean): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length === 0 || !valid(value)) {
    throw invalidRequest(name, 'invalid_filter', `${name} is invalid.`);
  }
  return value;
}

export function parseCostFilters(query: {
  provider?: unknown;
  deployment?: unknown;
  model?: unknown;
}): CostFilters {
  return {
    provider: optionalFilter(query.provider, 'provider', (text) => PROVIDERS.has(text)),
    deployment: optionalFilter(query.deployment, 'deployment', (text) => DEPLOYMENT_NAME.test(text)),
    model: optionalFilter(
      query.model,
      'model',
      (text) => text.length >= 1 && text.length <= 128 && !/\s/.test(text),
    ),
  };
}

function emptyBucket(): CostBucket {
  return {
    estimated: { attempts: 0, amount: null },
    provisional: { attempts: 0, amount: null },
    reconciled: { attempts: 0, amount: null },
    unknown: { attempts: 0, amount: null },
    currency: null,
  };
}

function addAmount(bucket: CostBucket, status: CostStatus, attempts: number, amount: string | null): void {
  const slot = bucket[status];
  slot.attempts += Number(attempts);
  if (amount === null) return;
  const canonical = canonicalDecimal(amount);
  slot.amount = slot.amount === null ? canonical : addDecimal(slot.amount, canonical);
  bucket.currency = 'USD';
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

function usageFromRow(row: AttemptCostRow): StoredUsage {
  return {
    promptTokens: count(row.prompt_tokens),
    completionTokens: count(row.completion_tokens),
    totalTokens: count(row.total_tokens),
    uncachedInputTokens: count(row.uncached_input_tokens),
    cacheCreationInputTokens: count(row.cache_creation_input_tokens),
    cacheReadInputTokens: count(row.cache_read_input_tokens),
    thoughtsTokens: count(row.thoughts_tokens),
  };
}

function storedFromRow(row: ExistingRow): CalculatedCost {
  return {
    costStatus: row.cost_status,
    amount: money(row.amount),
    allocatedStatus: row.allocated_status,
    allocatedAmount: money(row.allocated_amount),
    priceVersionId: row.price_version_id,
    currency: row.currency,
  };
}

async function readExisting(client: PoolClient, tenantId: string, attemptId: string): Promise<CalculatedCost | null> {
  const existing = await client.query<ExistingRow>(
    `SELECT cost_status, amount::text AS amount, allocated_status,
            allocated_amount::text AS allocated_amount, price_version_id, currency
     FROM attempt_costs
     WHERE tenant_id = $1 AND attempt_id = $2`,
    [tenantId, attemptId],
  );
  const row = existing.rows[0];
  return row === undefined ? null : storedFromRow(row);
}

export async function recordAttemptCost(
  client: PoolClient,
  tenantId: string,
  attemptId: string,
): Promise<CalculatedCost> {
  const attempt = await client.query<AttemptCostRow>(
    `SELECT c.provider, a.upstream_model AS model, c.location, d.service_tier, a.serving_provider, a.created_at,
            a.prompt_tokens, a.completion_tokens, a.total_tokens,
            a.uncached_input_tokens, a.cache_creation_input_tokens, a.cache_read_input_tokens, a.thoughts_tokens,
            a.expense_certainty
     FROM model_attempts a
     JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
     JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE a.tenant_id = $1 AND a.id = $2`,
    [tenantId, attemptId],
  );
  const row = attempt.rows[0];
  if (row === undefined) throw new Error('attempt was not stored');
  const provider = providerName(row.provider);
  const prices = await client.query<PriceRow>(
    `SELECT id, provider, model, region, service_tier, serving_provider, effective_at, created_at, price_source,
            verification_status, currency,
            input_rate::text AS input_rate, output_rate::text AS output_rate,
            cache_read_rate::text AS cache_read_rate, cache_write_rate::text AS cache_write_rate,
            thinking_rate::text AS thinking_rate, request_fee::text AS request_fee,
            allocated_rate::text AS allocated_rate
     FROM price_versions
     WHERE provider = $1 AND model = $2 AND effective_at <= $3`,
    [provider, row.model, row.created_at],
  );
  const selected = selectPrice(prices.rows.map(priceFromRow), {
    provider,
    model: row.model,
    location: row.location,
    serviceTier: row.service_tier,
    servingProvider: row.serving_provider,
    at: row.created_at,
  });
  const calculated = calculateCost({ provider, usage: usageFromRow(row), price: selected });
  const existing = await readExisting(client, tenantId, attemptId);
  const stored = costToStore(existing, calculated);
  const certainty = storedCertainty(row.expense_certainty, stored.amount);
  if (existing === null) {
    await client.query(
      `INSERT INTO attempt_costs (
         tenant_id, attempt_id, price_version_id, cost_status, amount,
         allocated_status, allocated_amount, currency, expense_certainty
       ) VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::numeric, $8, $9)`,
      [
        tenantId,
        attemptId,
        stored.priceVersionId,
        stored.costStatus,
        stored.amount,
        stored.allocatedStatus,
        stored.allocatedAmount,
        stored.currency,
        certainty,
      ],
    );
  }
  return stored;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}

// A failed cost statement aborts the transaction unless it rolls back to a savepoint.
// The attempt row stays stored.
export async function recordAttemptCostSafely(
  client: PoolClient,
  logger: Logger,
  tenantId: string,
  attemptId: string,
): Promise<void> {
  await client.query('SAVEPOINT attempt_cost');
  try {
    await recordAttemptCost(client, tenantId, attemptId);
    await client.query('RELEASE SAVEPOINT attempt_cost');
  } catch (error) {
    try {
      await client.query('ROLLBACK TO SAVEPOINT attempt_cost');
      await client.query('RELEASE SAVEPOINT attempt_cost');
    } catch (rollbackError) {
      throw rollbackError;
    }
    logger.error('attempt cost was not recorded', {
      severity: 'critical',
      attemptId,
      message: errorMessage(error),
    });
  }
}

const GROUP_SQL = `
  SELECT c.provider, d.name AS deployment, a.upstream_model AS model,
         ac.cost_status, count(*)::int AS attempts, sum(ac.amount)::text AS amount
  FROM attempt_costs ac
  JOIN model_attempts a ON a.tenant_id = ac.tenant_id AND a.id = ac.attempt_id
  JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
  JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
  JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
  WHERE r.created_at >= $1 AND r.created_at < $2
    AND ($3::text IS NULL OR c.provider = $3)
    AND ($4::text IS NULL OR d.name = $4)
    AND ($5::text IS NULL OR a.upstream_model = $5)
  GROUP BY c.provider, d.name, a.upstream_model, ac.cost_status
  ORDER BY c.provider, d.name, a.upstream_model, ac.cost_status`;

const ALLOCATED_SQL = `
  SELECT c.provider, d.name AS deployment, a.upstream_model AS model,
         ac.allocated_status AS cost_status, count(*)::int AS attempts,
         sum(ac.allocated_amount)::text AS amount
  FROM attempt_costs ac
  JOIN model_attempts a ON a.tenant_id = ac.tenant_id AND a.id = ac.attempt_id
  JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
  JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
  JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
  WHERE c.provider = 'dgx'
    AND ac.allocated_status IS NOT NULL
    AND r.created_at >= $1 AND r.created_at < $2
    AND ($3::text IS NULL OR c.provider = $3)
    AND ($4::text IS NULL OR d.name = $4)
    AND ($5::text IS NULL OR a.upstream_model = $5)
  GROUP BY c.provider, d.name, a.upstream_model, ac.allocated_status
  ORDER BY c.provider, d.name, a.upstream_model, ac.allocated_status`;

function groupKey(row: { provider: string; deployment: string; model: string }): string {
  return `${row.provider}\n${row.deployment}\n${row.model}`;
}

export async function summarizeCosts(
  client: PoolClient,
  from: Date,
  to: Date,
  filters: CostFilters,
): Promise<CostReport> {
  const params = [from, to, filters.provider, filters.deployment, filters.model];
  const externalRows = await client.query<GroupRow>(GROUP_SQL, params);
  const allocatedRows = await client.query<GroupRow>(ALLOCATED_SQL, params);
  const groups = new Map<string, CostReport['byProvider'][number]>();
  const ensure = (row: { provider: string; deployment: string; model: string }): CostReport['byProvider'][number] => {
    const key = groupKey(row);
    const existing = groups.get(key);
    if (existing !== undefined) return existing;
    const created = {
      provider: row.provider,
      deployment: row.deployment,
      model: row.model,
      external: emptyBucket(),
      dgxAllocated: emptyBucket(),
    };
    groups.set(key, created);
    return created;
  };
  for (const row of externalRows.rows) {
    if (!STATUSES.includes(row.cost_status)) continue;
    addAmount(ensure(row).external, row.cost_status, row.attempts, row.amount);
  }
  for (const row of allocatedRows.rows) {
    if (!STATUSES.includes(row.cost_status)) continue;
    addAmount(ensure(row).dgxAllocated, row.cost_status, row.attempts, row.amount);
  }
  const byProvider = [...groups.values()];
  const external = emptyBucket();
  const dgxAllocated = emptyBucket();
  for (const group of byProvider) {
    for (const status of STATUSES) {
      addAmount(external, status, group.external[status].attempts, group.external[status].amount);
      addAmount(dgxAllocated, status, group.dgxAllocated[status].attempts, group.dgxAllocated[status].amount);
    }
  }
  return {
    window: { from: from.toISOString(), to: to.toISOString() },
    external,
    dgxAllocated,
    byProvider,
  };
}
