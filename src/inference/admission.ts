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

function integerOption(optional: Record<string, unknown>, key: string): number | null {
  const value = optional[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}
