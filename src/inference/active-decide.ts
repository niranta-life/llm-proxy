import type { Pool } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import {
  allocateRateSlice,
  closeOpenRateEpochs,
  closeRateSlice,
  loadRateContext,
  markRateSliceSeeded,
  type SliceRow,
} from '../db/rate-epochs.js';
import {
  rateReason,
  readQuotaLevel,
  seedQuotaSlices,
  spendQuotaSlices,
  type QuotaSlice,
  type RateScope,
} from '../redis/active-quota.js';
import type { RedisCommandClient } from '../redis/hot-counters.js';

export type ActiveSkips = {
  apiKeyRequests: boolean;
  tenantRequests: boolean;
  apiKeyTokens: boolean;
  tenantTokens: boolean;
};

export type ActiveDecision =
  | { kind: 'passthrough' }
  | { kind: 'redis'; skips: ActiveSkips }
  | { kind: 'deny'; reason: string };

export type ActiveRedis = {
  timeoutMs: number;
  recoverIfDue(closeEpochs: () => Promise<number>): Promise<'ready' | 'blocked'>;
  command<T>(run: (client: RedisCommandClient) => Promise<T>): Promise<T>;
  noteFailure(): void;
  noteActive(decision: 'allow' | 'deny' | 'fallback'): void;
};

type ScopePlan = {
  scope: RateScope;
  scopeId: string;
  cost: number;
};

const SCOPE_ORDER: readonly RateScope[] = ['api_key_requests', 'tenant_requests', 'api_key_tokens', 'tenant_tokens'];

export function createActiveDecide(redis: ActiveRedis) {
  return async function decide(
    pool: Pool,
    input: {
      tenantId: string;
      apiKeyId: string;
      attemptId: string;
      tokenCost: number | null;
      now: Date;
    },
  ): Promise<ActiveDecision> {
    const windowStart = new Date(Math.floor(input.now.getTime() / 60_000) * 60_000);
    const plans = await withTenant(pool, input.tenantId, async (client) => {
      const context = await loadRateContext(client, input.tenantId, input.apiKeyId);
      return plannedScopes(context.limits, context.activations, input.tenantId, input.apiKeyId, input.tokenCost);
    });
    if (plans.length === 0) return { kind: 'passthrough' };
    const gate = await redis.recoverIfDue(() => closeOpenRateEpochs(pool, input.now));
    if (gate === 'blocked') {
      redis.noteActive('fallback');
      return { kind: 'deny', reason: 'rate_backend_uncertain' };
    }

    let lastReason = 'tenant_rate_limited';
    for (let pass = 0; pass < 2; pass += 1) {
      const prepared = await prepareSlices(pool, input.tenantId, plans, windowStart, input.now);
      if (prepared.kind === 'deny') return prepared;
      if (prepared.slices.length === 0) return { kind: 'passthrough' };
      const pending = prepared.slices.filter((slice) => slice.needsSeed);
      if (pending.length > 0) {
        const seeded = await redis.command((client) => seedQuotaSlices(client, pending, redis.timeoutMs));
        if (!seeded.ok) {
          await closeSlices(pool, input.tenantId, prepared.slices, input.now);
          redis.noteFailure();
          redis.noteActive('fallback');
          return { kind: 'deny', reason: 'rate_backend_uncertain' };
        }
        const marked = await markSlices(pool, input.tenantId, pending, windowStart);
        if (!marked) {
          await closeSlices(pool, input.tenantId, prepared.slices, input.now);
          redis.noteFailure();
          redis.noteActive('fallback');
          return { kind: 'deny', reason: 'rate_backend_uncertain' };
        }
      }
      const spent = await redis.command((client) => spendQuotaSlices(client, prepared.slices, input.attemptId, redis.timeoutMs));
      if (spent.decision === 'allow') {
        redis.noteActive('allow');
        return { kind: 'redis', skips: skipsFor(prepared.slices) };
      }
      if (spent.decision === 'deny' && spent.reason === 'empty' && pass === 0) {
        await closeSlices(pool, input.tenantId, prepared.slices, input.now);
        lastReason = await shortReason(redis, prepared.slices);
        continue;
      }
      if (spent.decision === 'deny') {
        redis.noteActive('deny');
        return { kind: 'deny', reason: await shortReason(redis, prepared.slices) };
      }
      await closeSlices(pool, input.tenantId, prepared.slices, input.now);
      redis.noteFailure();
      redis.noteActive('fallback');
      return { kind: 'deny', reason: 'rate_backend_uncertain' };
    }
    redis.noteActive('deny');
    return { kind: 'deny', reason: lastReason };
  };
}

function plannedScopes(
  limits: {
    tenantMode: string | null;
    tenantRequestsPerMinute: number | null;
    tenantTokensPerMinute: number | null;
    apiKeyMode: string | null;
    apiKeyRequestsPerMinute: number | null;
    apiKeyTokensPerMinute: number | null;
  },
  activations: Array<{ scope: RateScope; scopeId: string }>,
  tenantId: string,
  apiKeyId: string,
  tokenCost: number | null,
): ScopePlan[] {
  const approved = new Set(activations.map((row) => `${row.scope}:${row.scopeId.toLowerCase()}`));
  const keyMode = limits.apiKeyMode ?? limits.tenantMode;
  const candidates: Array<ScopePlan & { mode: string | null; limit: number | null }> = [
    {
      scope: 'api_key_requests',
      scopeId: apiKeyId,
      cost: 1,
      mode: keyMode,
      limit: limits.apiKeyRequestsPerMinute,
    },
    {
      scope: 'tenant_requests',
      scopeId: tenantId,
      cost: 1,
      mode: limits.tenantMode,
      limit: limits.tenantRequestsPerMinute,
    },
  ];
  if (tokenCost !== null && tokenCost > 0) {
    candidates.push(
      {
        scope: 'api_key_tokens',
        scopeId: apiKeyId,
        cost: tokenCost,
        mode: keyMode,
        limit: limits.apiKeyTokensPerMinute,
      },
      {
        scope: 'tenant_tokens',
        scopeId: tenantId,
        cost: tokenCost,
        mode: limits.tenantMode,
        limit: limits.tenantTokensPerMinute,
      },
    );
  }
  return candidates
    .filter((candidate) => candidate.mode === 'hard' && candidate.limit !== null)
    .filter((candidate) => approved.has(`${candidate.scope}:${candidate.scopeId.toLowerCase()}`))
    .map((candidate) => ({ scope: candidate.scope, scopeId: candidate.scopeId, cost: candidate.cost }));
}

async function prepareSlices(
  pool: Pool,
  tenantId: string,
  plans: readonly ScopePlan[],
  windowStart: Date,
  now: Date,
): Promise<{ kind: 'ok'; slices: QuotaSlice[] } | { kind: 'deny'; reason: string }> {
  try {
    return await withTenant(pool, tenantId, async (client) => {
      const slices: QuotaSlice[] = [];
      for (const plan of plans) {
        const row = await allocateRateSlice(client, {
          tenantId,
          scope: plan.scope,
          scopeId: plan.scopeId,
          windowStart,
          cost: plan.cost,
          now,
        });
        if (row.outcome === 'inactive') continue;
        if (row.outcome === 'deny') {
          throw new AllocationDenied(denyReason(row, plan.scope));
        }
        const slice = toSlice(tenantId, plan, windowStart, row);
        if (slice === null) throw new AllocationDenied('rate_backend_uncertain');
        slices.push(slice);
      }
      return { kind: 'ok' as const, slices };
    });
  } catch (error) {
    if (error instanceof AllocationDenied) return { kind: 'deny', reason: error.reason };
    throw error;
  }
}

function toSlice(tenantId: string, plan: ScopePlan, windowStart: Date, row: SliceRow): QuotaSlice | null {
  if (
    (row.outcome !== 'seed' && row.outcome !== 'spend')
    || row.epoch === null
    || row.allocated === null
    || row.version === null
    || row.generation === null
    || row.policyRevision === null
  ) {
    return null;
  }
  return {
    tenantId,
    scope: plan.scope,
    scopeId: plan.scopeId,
    windowMs: windowStart.getTime(),
    epoch: row.epoch,
    generation: row.generation,
    revision: row.policyRevision,
    amount: row.allocated,
    cost: plan.cost,
    version: row.version,
    needsSeed: row.seeded === false,
  };
}

function denyReason(row: SliceRow, scope: RateScope): string {
  if (row.reason === 'epoch_bound') return 'rate_backend_uncertain';
  if (row.reason === 'rate_limited') return rateReason(scope);
  return 'rate_backend_uncertain';
}

async function markSlices(pool: Pool, tenantId: string, slices: readonly QuotaSlice[], windowStart: Date): Promise<boolean> {
  return withTenant(pool, tenantId, async (client) => {
    for (const slice of slices) {
      const marked = await markRateSliceSeeded(client, {
        tenantId,
        scope: slice.scope,
        scopeId: slice.scopeId,
        windowStart,
        epoch: slice.epoch,
        version: slice.version,
      });
      if (!marked) return false;
    }
    return true;
  });
}

async function closeSlices(pool: Pool, tenantId: string, slices: readonly QuotaSlice[], now: Date): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    for (const slice of slices) {
      await closeRateSlice(client, {
        tenantId,
        scope: slice.scope,
        scopeId: slice.scopeId,
        windowStart: new Date(slice.windowMs),
        epoch: slice.epoch,
        now,
      });
    }
  });
}

async function shortReason(redis: ActiveRedis, slices: readonly QuotaSlice[]): Promise<string> {
  const levels = await redis.command(async (client) => {
    const found: Array<{ scope: RateScope; level: number | null; cost: number }> = [];
    for (const slice of slices) {
      found.push({ scope: slice.scope, level: await readQuotaLevel(client, slice, redis.timeoutMs), cost: slice.cost });
    }
    return found;
  });
  for (const scope of SCOPE_ORDER) {
    const match = levels.find((level) => level.scope === scope);
    if (match !== undefined && (match.level === null || match.level < match.cost)) return rateReason(scope);
  }
  return rateReason(slices[0]?.scope ?? 'tenant_requests');
}

function skipsFor(slices: readonly QuotaSlice[]): ActiveSkips {
  const names = new Set(slices.map((slice) => slice.scope));
  return {
    apiKeyRequests: names.has('api_key_requests'),
    tenantRequests: names.has('tenant_requests'),
    apiKeyTokens: names.has('api_key_tokens'),
    tenantTokens: names.has('tenant_tokens'),
  };
}

class AllocationDenied extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'AllocationDenied';
  }
}
