import type { Pool, PoolClient } from 'pg';
import { admitAttempt, closeAttemptAdmission, loadAdmissionPrices, loadDeploymentServiceTier } from '../db/admission.js';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { addDecimal, canonicalDecimal, maxDecimal, multiplyDecimal, selectPrice, type PriceCandidate } from './cost.js';
import { ProxyError, proxyError } from './errors.js';
import type { ResolvedRoute } from './resolve.js';
import type { ChatRequest } from './validate.js';

const ADMISSION_MESSAGES: Record<string, string> = {
  tenant_rate_limited: 'The request rate limit was reached.',
  api_key_rate_limited: 'The API key request rate limit was reached.',
  concurrency_limited: 'The concurrency limit was reached.',
  api_key_concurrency_limited: 'The API key concurrency limit was reached.',
  stream_limited: 'The stream concurrency limit was reached.',
  api_key_stream_limited: 'The API key stream limit was reached.',
  connection_limited: 'The connection concurrency limit was reached.',
  deployment_limited: 'The deployment concurrency limit was reached.',
  token_rate_limited: 'The token rate limit was reached.',
  api_key_token_limited: 'The API key token rate limit was reached.',
  budget_exceeded: 'The budget limit was reached.',
  budget_unbounded: 'The cost is unbounded.',
  budget_unknown: 'The cost is unknown.',
};

export function isAdmissionCode(code: string | null): boolean {
  return code === 'admission_unavailable' || (code !== null && Object.hasOwn(ADMISSION_MESSAGES, code));
}

export function admissionError(reason: string): ProxyError {
  const message = ADMISSION_MESSAGES[reason];
  if (message === undefined) {
    return proxyError(503, 'server_error', 'admission_unavailable', null, 'Admission is unavailable.');
  }
  return proxyError(429, 'rate_limit_error', reason, null, message);
}

export function periodStart(ms: number): string {
  const date = new Date(ms);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-01`;
}

export function windowStart(ms: number): Date {
  return new Date(Math.floor(ms / 60_000) * 60_000);
}

export function inputBound(request: ChatRequest): number {
  let total = 0;
  for (const message of request.messages) total += message.content.length;
  return total;
}

export function outputBound(request: ChatRequest, route: ResolvedRoute): number | null {
  const requested = integerOption(request.optional, 'max_tokens') ?? integerOption(request.optional, 'max_completion_tokens');
  return requested ?? route.defaultMaxOutputTokens;
}

export function tokenBound(request: ChatRequest, route: ResolvedRoute): number | null {
  const output = outputBound(request, route);
  if (output === null) return null;
  return inputBound(request) + output;
}

export type ChargeEstimate = {
  kind: 'bounded' | 'unbounded' | 'unknown';
  amount: string | null;
  priceVersionId: string | null;
};

function nonzero(rate: string | null): boolean {
  if (rate === null) return false;
  return canonicalDecimal(rate) !== '0';
}

function highestRate(rates: Array<string | null>): string | null {
  const present = rates.filter((rate): rate is string => rate !== null);
  if (present.length === 0) return null;
  return present.reduce((best, rate) => maxDecimal(best, rate));
}

export function estimateCharge(price: PriceCandidate | null, inputCount: number, outputCount: number | null): ChargeEstimate {
  if (price === null) return { kind: 'unknown', amount: null, priceVersionId: null };
  const hasExternal = [
    price.inputRate,
    price.outputRate,
    price.cacheReadRate,
    price.cacheWriteRate,
    price.thinkingRate,
    price.requestFee,
  ].some((rate) => rate !== null);
  if (!hasExternal) return { kind: 'unknown', amount: null, priceVersionId: price.id };
  if (nonzero(price.thinkingRate)) return { kind: 'unbounded', amount: null, priceVersionId: price.id };
  if (nonzero(price.outputRate) && outputCount === null) {
    return { kind: 'unbounded', amount: null, priceVersionId: price.id };
  }
  let total = '0';
  const inputWorst = highestRate([price.inputRate, price.cacheReadRate, price.cacheWriteRate]);
  if (inputWorst !== null) total = addDecimal(total, multiplyDecimal(inputWorst, inputCount));
  if (price.outputRate !== null && outputCount !== null) {
    total = addDecimal(total, multiplyDecimal(price.outputRate, outputCount));
  }
  if (price.requestFee !== null) total = addDecimal(total, canonicalDecimal(price.requestFee));
  return { kind: 'bounded', amount: total, priceVersionId: price.id };
}

async function quoteAttempt(
  client: PoolClient,
  input: {
    tenantId: string;
    route: ResolvedRoute;
    request: ChatRequest;
    now: Date;
  },
): Promise<ChargeEstimate> {
  const serviceTier = await loadDeploymentServiceTier(client, input.tenantId, input.route.deploymentId);
  const prices = await loadAdmissionPrices(client, input.route.provider, input.route.upstreamModel, input.now);
  const selected = selectPrice(prices, {
    provider: input.route.provider,
    model: input.route.upstreamModel,
    location: input.route.location,
    serviceTier,
    servingProvider: null,
    at: input.now,
  });
  return estimateCharge(selected, inputBound(input.request), outputBound(input.request, input.route));
}

export async function admitChatAttempt(
  pool: Pool,
  input: {
    tenantId: string;
    apiKeyId: string;
    route: ResolvedRoute;
    request: ChatRequest;
    attemptId: string;
    stream: boolean;
    now: Date;
  },
): Promise<void> {
  try {
    await withTenant(pool, input.tenantId, async (client) => {
      const quote = await quoteAttempt(client, input);
      const decision = await admitAttempt(client, {
        tenantId: input.tenantId,
        apiKeyId: input.apiKeyId,
        connectionId: input.route.connectionId,
        deploymentId: input.route.deploymentId,
        attemptId: input.attemptId,
        stream: input.stream,
        now: input.now,
        windowStart: windowStart(input.now.getTime()),
        periodStart: periodStart(input.now.getTime()),
        tokenBound: tokenBound(input.request, input.route),
        estimate: quote.amount,
        estimateKind: quote.kind,
        priceVersionId: quote.priceVersionId,
      });
      if (decision.decision !== 'allow') throw admissionError(decision.reason);
    });
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    throw admissionError('admission_unavailable');
  }
}

export async function settleChatAttempt(
  pool: Pool,
  logger: Logger,
  tenantId: string,
  attemptId: string,
  now: Date,
): Promise<void> {
  try {
    await withTenant(pool, tenantId, (client) => closeAttemptAdmission(client, tenantId, attemptId, now));
  } catch (error) {
    logger.error('admission was not closed', {
      severity: 'critical',
      attemptId,
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

export async function fallbackResourcesAllow(
  pool: Pool,
  input: {
    tenantId: string;
    apiKeyId: string;
    route: ResolvedRoute;
    request: ChatRequest;
    stream: boolean;
    now: Date;
    releasingAttemptId: string;
  },
): Promise<boolean> {
  try {
    return await withTenant(pool, input.tenantId, async (client) => {
      const quote = await quoteAttempt(client, input);
      if (!(await budgetAllows(client, input.tenantId, input.now, quote))) return false;
      return limitsAllow(client, input, tokenBound(input.request, input.route));
    });
  } catch {
    return false;
  }
}

async function budgetAllows(
  client: PoolClient,
  tenantId: string,
  now: Date,
  quote: ChargeEstimate,
): Promise<boolean> {
  const budget = await client.query<{ mode: string }>(
    `SELECT mode FROM tenant_budgets WHERE tenant_id = $1`,
    [tenantId],
  );
  const mode = budget.rows[0]?.mode;
  if (mode === undefined || mode === 'disabled' || mode === 'observe') return true;
  if (mode !== 'hard') return false;
  if (quote.kind !== 'bounded' || quote.amount === null) return false;
  const fit = await client.query<{ allowed: boolean }>(
    `SELECT (
       $1::numeric <= (
         b.monthly_amount
         - COALESCE((
             SELECT SUM(amount)
             FROM cost_ledger
             WHERE tenant_id = b.tenant_id
               AND period_start = $2::date
               AND entry_type = 'settle'
           ), 0)
         - COALESCE((
             SELECT SUM(reserved_amount)
             FROM budget_reservations
             WHERE tenant_id = b.tenant_id
               AND period_start = $2::date
               AND status IN ('active', 'provisional')
               AND reserved_amount IS NOT NULL
           ), 0)
       )
     ) AS allowed
     FROM tenant_budgets b
     WHERE b.tenant_id = $3 AND b.mode = 'hard'`,
    [quote.amount, periodStart(now.getTime()), tenantId],
  );
  return fit.rows[0]?.allowed === true;
}

async function limitsAllow(
  client: PoolClient,
  input: {
    tenantId: string;
    apiKeyId: string;
    route: ResolvedRoute;
    stream: boolean;
    now: Date;
    releasingAttemptId: string;
  },
  tokens: number | null,
): Promise<boolean> {
  const window = windowStart(input.now.getTime());
  const tenant = await client.query<{
    mode: string;
    requests_per_minute: number | null;
    concurrent_requests: number | null;
    concurrent_streams: number | null;
    token_rate_per_minute: string | null;
  }>(
    `SELECT mode, requests_per_minute, concurrent_requests, concurrent_streams, token_rate_per_minute::text
     FROM tenant_limit_policies
     WHERE tenant_id = $1`,
    [input.tenantId],
  );
  const key = await client.query<{
    mode: string | null;
    requests_per_minute: number | null;
    concurrent_requests: number | null;
    concurrent_streams: number | null;
    token_rate_per_minute: string | null;
  }>(
    `SELECT mode, requests_per_minute, concurrent_requests, concurrent_streams, token_rate_per_minute::text
     FROM api_key_limit_policies
     WHERE api_key_id = $1`,
    [input.apiKeyId],
  );
  if (!(await rateAllows(client, input.tenantId, 'tenant_requests', input.tenantId, window, tenant.rows[0]?.mode ?? null, tenant.rows[0]?.requests_per_minute ?? null))) {
    return false;
  }
  if (!(await rateAllows(client, input.tenantId, 'api_key_requests', input.apiKeyId, window, key.rows[0]?.mode ?? null, key.rows[0]?.requests_per_minute ?? null))) {
    return false;
  }
  if (!(await leaseAllows(client, 'tenant_request', input.tenantId, input.now, tenant.rows[0]?.mode ?? null, tenant.rows[0]?.concurrent_requests ?? null, input.releasingAttemptId))) {
    return false;
  }
  if (!(await leaseAllows(client, 'api_key_request', input.apiKeyId, input.now, key.rows[0]?.mode ?? null, key.rows[0]?.concurrent_requests ?? null, input.releasingAttemptId))) {
    return false;
  }
  if (input.stream) {
    if (!(await leaseAllows(client, 'tenant_stream', input.tenantId, input.now, tenant.rows[0]?.mode ?? null, tenant.rows[0]?.concurrent_streams ?? null, input.releasingAttemptId))) {
      return false;
    }
    if (!(await leaseAllows(client, 'api_key_stream', input.apiKeyId, input.now, key.rows[0]?.mode ?? null, key.rows[0]?.concurrent_streams ?? null, input.releasingAttemptId))) {
      return false;
    }
  }
  if (tokens !== null) {
    if (!(await tokenAllows(client, input.tenantId, 'tenant_tokens', input.tenantId, window, tenant.rows[0]?.mode ?? null, tenant.rows[0]?.token_rate_per_minute ?? null, tokens))) {
      return false;
    }
    if (!(await tokenAllows(client, input.tenantId, 'api_key_tokens', input.apiKeyId, window, key.rows[0]?.mode ?? null, key.rows[0]?.token_rate_per_minute ?? null, tokens))) {
      return false;
    }
  }
  const connection = await client.query<{ mode: string; max_concurrency: number; share_group: string | null }>(
    `SELECT mode, max_concurrency, share_group
     FROM connection_limit_policies
     WHERE connection_id = $1`,
    [input.route.connectionId],
  );
  const connectionRow = connection.rows[0];
  if (connectionRow !== undefined && connectionRow.mode === 'hard') {
    if (connectionRow.share_group === null) {
      if (!(await leaseAllows(client, 'connection', input.route.connectionId, input.now, 'hard', connectionRow.max_concurrency, input.releasingAttemptId))) {
        return false;
      }
    } else {
      const group = await client.query<{ id: string }>(
        `SELECT id FROM connection_share_groups WHERE name = $1`,
        [connectionRow.share_group],
      );
      const cap = await client.query<{ max: number | null }>(
        `SELECT MIN(max_concurrency)::int AS max
         FROM connection_limit_policies
         WHERE share_group = $1 AND mode = 'hard'`,
        [connectionRow.share_group],
      );
      const groupId = group.rows[0]?.id;
      const max = cap.rows[0]?.max ?? null;
      if (groupId === undefined || max === null) return false;
      if (!(await leaseAllows(client, 'connection_group', groupId, input.now, 'hard', max, input.releasingAttemptId))) return false;
    }
  }
  const deployment = await client.query<{ mode: string; max_concurrency: number }>(
    `SELECT mode, max_concurrency
     FROM deployment_limit_policies
     WHERE deployment_id = $1`,
    [input.route.deploymentId],
  );
  const deploymentRow = deployment.rows[0];
  if (deploymentRow !== undefined && deploymentRow.mode === 'hard') {
    if (!(await leaseAllows(client, 'deployment', input.route.deploymentId, input.now, 'hard', deploymentRow.max_concurrency, input.releasingAttemptId))) {
      return false;
    }
  }
  return true;
}

async function rateAllows(
  client: PoolClient,
  tenantId: string,
  scope: string,
  scopeId: string,
  window: Date,
  mode: string | null,
  limit: number | null,
): Promise<boolean> {
  if (mode !== 'hard' || limit === null) return true;
  const amount = await counterAmount(client, tenantId, scope, scopeId, window);
  return amount + 1 <= limit;
}

async function tokenAllows(
  client: PoolClient,
  tenantId: string,
  scope: string,
  scopeId: string,
  window: Date,
  mode: string | null,
  limit: string | null,
  tokens: number,
): Promise<boolean> {
  if (mode !== 'hard' || limit === null) return true;
  const amount = await counterAmount(client, tenantId, scope, scopeId, window);
  return amount + tokens <= Number(limit);
}

async function leaseAllows(
  client: PoolClient,
  scope: string,
  scopeId: string,
  now: Date,
  mode: string | null,
  limit: number | null,
  releasingAttemptId: string,
): Promise<boolean> {
  if (mode !== 'hard' || limit === null) return true;
  // Settlement releases this attempt before the next admission.
  // The preview must not count leases that release will clear.
  const result = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM concurrency_leases
     WHERE scope = $1 AND scope_id = $2 AND released_at IS NULL AND expires_at > $3
       AND attempt_id IS DISTINCT FROM $4::uuid`,
    [scope, scopeId, now, releasingAttemptId],
  );
  return (result.rows[0]?.count ?? 0) < limit;
}

async function counterAmount(
  client: PoolClient,
  tenantId: string,
  scope: string,
  scopeId: string,
  window: Date,
): Promise<number> {
  const result = await client.query<{ amount: string }>(
    `SELECT COALESCE((
       SELECT amount
       FROM limit_counters
       WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3 AND window_start = $4
     ), 0)::text AS amount`,
    [tenantId, scope, scopeId, window],
  );
  return Number(result.rows[0]?.amount ?? '0');
}

function integerOption(optional: Record<string, unknown>, key: string): number | null {
  const value = optional[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}
