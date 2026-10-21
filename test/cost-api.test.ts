import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { calculateCost, type StoredUsage } from '../src/inference/cost.js';
import { recordAttemptCost } from '../src/inference/cost-store.js';
import { resolveModel } from '../src/inference/resolve.js';
import { finishAttempt, insertPending, loadCatalog } from '../src/inference/store.js';
import {
  cliEntry,
  configFor,
  createTestApp,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
} from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';
import { registerPrivate } from './private-support.js';

type CostAmount = { attempts: number; amount: string | null };
type CostBucket = {
  estimated: CostAmount;
  provisional: CostAmount;
  reconciled: CostAmount;
  unknown: CostAmount;
  currency: 'USD' | null;
};
type CostGroup = {
  provider: string;
  deployment: string;
  model: string;
  external: CostBucket;
  dgxAllocated: CostBucket;
};
type CostBody = {
  external: CostBucket;
  dgxAllocated: CostBucket;
  byProvider: CostGroup[];
};

type AttemptInput = {
  status: 'succeeded' | 'failed';
  errorCode: string | null;
  usage: StoredUsage;
  servingProvider?: string | null;
};

const db = loadTestDatabase();
const pools: { end: () => Promise<unknown> }[] = [];

beforeAll(async () => {
  const admin = adminPool(db);
  try {
    await admin.query('GRANT INSERT ON attempt_costs TO llm_runtime');
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  await Promise.all(pools.map((pool) => pool.end()));
});

function cli(args: string[]): Record<string, unknown> {
  return runCli(db, args, cliEnv()) as Record<string, unknown>;
}

function ago(milliseconds: number): string {
  return new Date(Date.now() - milliseconds).toISOString();
}

function registerStoredPrice(
  input: {
    provider: string;
    model: string;
    inputRate?: string;
    outputRate?: string;
    cacheReadRate?: string;
    cacheWriteRate?: string;
    thinkingRate?: string;
    allocatedRate?: string;
    region?: string;
    serviceTier?: string;
    servingProvider?: string;
    status?: string;
    effectiveAt?: string;
  },
): string {
  const args = [
    'register-price',
    '--provider',
    input.provider,
    '--upstream-model',
    input.model,
    '--effective-at',
    input.effectiveAt ?? ago(60_000),
    '--source',
    'fixture',
    '--status',
    input.status ?? 'verified',
  ];
  if (input.region !== undefined) args.push('--location', input.region);
  if (input.serviceTier !== undefined) args.push('--service-tier', input.serviceTier);
  if (input.servingProvider !== undefined) args.push('--serving-provider', input.servingProvider);
  if (input.inputRate !== undefined) args.push('--input-rate', input.inputRate);
  if (input.outputRate !== undefined) args.push('--output-rate', input.outputRate);
  if (input.cacheReadRate !== undefined) args.push('--cache-read-rate', input.cacheReadRate);
  if (input.cacheWriteRate !== undefined) args.push('--cache-write-rate', input.cacheWriteRate);
  if (input.thinkingRate !== undefined) args.push('--thinking-rate', input.thinkingRate);
  if (input.allocatedRate !== undefined) args.push('--allocated-rate', input.allocatedRate);
  const created = cli(args);
  if (typeof created.id !== 'string') throw new Error('price was not stored');
  return created.id;
}

function deployment(tenantId: string, provider: string, name: string, model: string): void {
  cli([
    'register-deployment',
    '--tenant-id',
    tenantId,
    '--provider',
    provider,
    '--name',
    name,
    '--upstream-model',
    model,
    '--timeout-ms',
    '5000',
    '--capabilities',
    'temperature',
    '--enabled',
    'true',
  ]);
}

function blankUsage(): StoredUsage {
  return {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
  };
}

async function storeAttempt(tenantId: string, model: string, input: AttemptInput): Promise<ReturnType<typeof calculateCost>> {
  const runtime = createPool(configFor(db), 'runtime', undefined, 1);
  pools.push(runtime);
  return withTenant(runtime, tenantId, async (client) => {
    const catalog = await loadCatalog(client);
    const route = resolveModel(model, catalog.deployments, catalog.aliases);
    if (route === null) throw new Error(`route missing for ${model}`);
    const pending = await insertPending(client, tenantId, route);
    await finishAttempt(client, {
      tenantId,
      requestId: pending.requestId,
      attemptId: pending.attemptId,
      status: input.status,
      errorCode: input.errorCode,
      durationMs: 4,
      usage: {
        promptTokens: input.usage.promptTokens,
        completionTokens: input.usage.completionTokens,
        totalTokens: input.usage.totalTokens,
      },
      providerRequestId: null,
      stopReason: input.status === 'succeeded' ? 'stop' : null,
      uncachedInputTokens: input.usage.uncachedInputTokens,
      cacheCreationInputTokens: input.usage.cacheCreationInputTokens,
      cacheReadInputTokens: input.usage.cacheReadInputTokens,
      thoughtsTokens: input.usage.thoughtsTokens,
      servingProvider: input.servingProvider ?? null,
    });
    return recordAttemptCost(client, tenantId, pending.attemptId);
  });
}

function costUrl(appQuery: string): string {
  const from = new Date(Date.now() - 180_000).toISOString();
  const to = new Date(Date.now() + 180_000).toISOString();
  return `/internal/v1/metrics/costs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${appQuery}`;
}

function headers(tenantId: string, secret: string): Record<string, string> {
  return { 'x-tenant-id': tenantId, authorization: `Bearer ${secret}` };
}

function group(body: CostBody, model: string): CostGroup {
  const found = body.byProvider.find((row) => row.model === model);
  if (found === undefined) throw new Error(`missing cost group ${model}`);
  return found;
}

function attempts(bucket: CostBucket): number {
  return bucket.estimated.attempts + bucket.provisional.attempts + bucket.reconciled.attempts + bucket.unknown.attempts;
}

describe('model cost API', () => {
  it('reports a chat cost without changing the chat', async () => {
    const mock = await startMockUpstream();
    const tenant = provisionTenant(db, 'Cost OpenAI');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-cost-openai',
      deployment: 'cost-openai',
      upstreamModel: 'gpt-cost-test',
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    pools.push(ctx.authPool, ctx.runtimePool);
    const admin = adminPool(db);
    pools.push(admin);
    try {
      const first = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { ...headers(tenant.tenantId, tenant.secret), 'content-type': 'application/json' },
        payload: chatPayload('cost-openai', 'before-price'),
      });
      expect(first.statusCode).toBe(200);
      const firstBody = first.json();
      expect(firstBody.model).toBe('gpt-cost-test');
      expect(firstBody.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      expect(Object.keys(firstBody.usage).sort()).toEqual(['completion_tokens', 'prompt_tokens', 'total_tokens']);
      expect(firstBody.cost).toBeUndefined();

      const unknown = await ctx.app.inject({
        method: 'GET',
        url: costUrl(''),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect(unknown.statusCode).toBe(200);
      const unknownBody = unknown.json() as CostBody;
      expect(unknownBody.external.unknown).toEqual({ attempts: 1, amount: null });
      expect(unknownBody.external.estimated.amount).toBeNull();
      expect(unknownBody.byProvider).toEqual([
        expect.objectContaining({ provider: 'openai', deployment: 'cost-openai', model: 'gpt-cost-test' }),
      ]);

      const genericId = registerStoredPrice({
        provider: 'openai',
        model: 'gpt-cost-test',
        inputRate: '0.1',
        outputRate: '0.2',
        effectiveAt: ago(120_000),
      });
      const second = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { ...headers(tenant.tenantId, tenant.secret), 'content-type': 'application/json' },
        payload: chatPayload('cost-openai', 'priced'),
      });
      expect(second.statusCode).toBe(200);
      expect(second.json().usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      expect(second.json().cost).toBeUndefined();

      const tier = cli([
        'set-deployment-service-tier',
        '--tenant-id',
        tenant.tenantId,
        '--deployment',
        'cost-openai',
        '--service-tier',
        'batch',
      ]);
      expect(tier.serviceTier).toBe('batch');
      const tierId = registerStoredPrice({
        provider: 'openai',
        model: 'gpt-cost-test',
        inputRate: '0.5',
        outputRate: '0.5',
        serviceTier: 'batch',
        effectiveAt: ago(90_000),
      });
      const third = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { ...headers(tenant.tenantId, tenant.secret), 'content-type': 'application/json' },
        payload: chatPayload('cost-openai', 'tier'),
      });
      expect(third.statusCode).toBe(200);

      const rows = await admin.query<{
        id: string;
        amount: string | null;
        cost_status: string | null;
        price_version_id: string | null;
      }>(
        `SELECT a.id, ac.amount::text AS amount, ac.cost_status, ac.price_version_id
         FROM model_attempts a
         LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
         WHERE a.tenant_id = $1
         ORDER BY a.created_at`,
        [tenant.tenantId],
      );
      expect(rows.rows.map((row) => row.amount)).toEqual([null, '0.7', '2.5']);
      expect(rows.rows[1]?.price_version_id).toBe(genericId);
      expect(rows.rows[2]?.price_version_id).toBe(tierId);
      const pricedAttempt = rows.rows[1]?.id;
      if (pricedAttempt === undefined) throw new Error('priced attempt is missing');

      const reconciled = cli([
        'reconcile-attempt-cost',
        '--tenant-id',
        tenant.tenantId,
        '--attempt-id',
        pricedAttempt,
      ]);
      expect(reconciled.costStatus).toBe('reconciled');
      expect(reconciled.amount).toBe('0.7');
      expect(reconciled.priceVersionId).toBe(genericId);

      registerStoredPrice({
        provider: 'openai',
        model: 'gpt-cost-test',
        inputRate: '0.9',
        outputRate: '0.9',
        effectiveAt: ago(1_000),
      });
      const runtime = createPool(configFor(db), 'runtime', undefined, 1);
      pools.push(runtime);
      const again = await withTenant(runtime, tenant.tenantId, (client) =>
        recordAttemptCost(client, tenant.tenantId, pricedAttempt),
      );
      expect(again.amount).toBe('0.7');
      expect(again.costStatus).toBe('reconciled');
      expect(again.priceVersionId).toBe(genericId);

      const fourth = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { ...headers(tenant.tenantId, tenant.secret), 'content-type': 'application/json' },
        payload: chatPayload('cost-openai', 'still-tier'),
      });
      expect(fourth.statusCode).toBe(200);
      const after = await admin.query<{ amount: string | null; cost_status: string }>(
        `SELECT ac.amount::text AS amount, ac.cost_status
         FROM model_attempts a
         JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
         WHERE a.tenant_id = $1
         ORDER BY a.created_at`,
        [tenant.tenantId],
      );
      expect(after.rows.map((row) => `${row.cost_status}:${row.amount}`)).toEqual([
        'unknown:null',
        'reconciled:0.7',
        'estimated:2.5',
        'estimated:2.5',
      ]);

      const report = await ctx.app.inject({
        method: 'GET',
        url: costUrl(''),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect(report.statusCode).toBe(200);
      const body = report.json() as CostBody;
      expect(body.external.estimated).toEqual({ attempts: 2, amount: '5' });
      expect(body.external.reconciled).toEqual({ attempts: 1, amount: '0.7' });
      expect(body.external.unknown).toEqual({ attempts: 1, amount: null });
      expect(body.external.provisional).toEqual({ attempts: 0, amount: null });
      expect(body.external.currency).toBe('USD');
      expect(body.dgxAllocated.estimated.attempts).toBe(0);
      expect(body.dgxAllocated.currency).toBeNull();
      expect(body.byProvider).toHaveLength(1);
      expect(body.byProvider[0]).toMatchObject({
        provider: 'openai',
        deployment: 'cost-openai',
        model: 'gpt-cost-test',
      });
      console.log(`COST_API ${JSON.stringify(body)}`);

      const byProvider = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&provider=openai'),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect((byProvider.json() as CostBody).external.estimated.amount).toBe('5');
      const byDeployment = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&deployment=cost-openai'),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect((byDeployment.json() as CostBody).byProvider).toHaveLength(1);
      const byModel = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&model=gpt-cost-test'),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect((byModel.json() as CostBody).external.reconciled.amount).toBe('0.7');
      const otherProvider = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&provider=anthropic'),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect(attempts((otherProvider.json() as CostBody).external)).toBe(0);
      const otherDeployment = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&deployment=cost-beta'),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect((otherDeployment.json() as CostBody).byProvider).toEqual([]);

      const summary = await ctx.app.inject({
        method: 'GET',
        url: `/internal/v1/metrics/summary?from=${encodeURIComponent(new Date(Date.now() - 180_000).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 180_000).toISOString())}`,
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect(summary.statusCode).toBe(200);
      expect(summary.json()).not.toHaveProperty('price');

      const badProvider = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&provider='),
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect(badProvider.statusCode).toBe(400);
      expect(badProvider.json().error.code).toBe('invalid_filter');
      const badWindow = await ctx.app.inject({
        method: 'GET',
        url: '/internal/v1/metrics/costs?from=yesterday&to=today',
        headers: headers(tenant.tenantId, tenant.secret),
      });
      expect(badWindow.statusCode).toBe(400);
      expect(badWindow.json().error.code).toBe('invalid_window');
    } finally {
      await mock.close();
    }
  });

  it('costs provider attempts and keeps tenants on their own rows', async () => {
    const tenant = provisionTenant(db, 'Cost Providers');
    const env = cliEnv();
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-cost-test',
      endpoint: 'https://anthropic.invalid',
      deployment: 'cost-anthropic',
      upstreamModel: 'claude-cost-test',
      alias: false,
    });
    runCli(
      db,
      [
        'register-vertex-connection',
        '--tenant-id',
        tenant.tenantId,
        '--auth-mode',
        'adc',
        '--project',
        'cost-vertex-proj',
        '--location',
        'us-central1',
      ],
      env,
    );
    deployment(tenant.tenantId, 'vertex', 'cost-vertex', 'gemini-cost-test');
    runCli(db, ['register-openrouter-connection', '--tenant-id', tenant.tenantId, '--api-key', 'or-cost-test-key'], env);
    deployment(tenant.tenantId, 'openrouter', 'cost-openrouter', 'route-cost-test');
    registerPrivate(db, {
      tenantId: tenant.tenantId,
      deployment: 'cost-dgx',
      upstreamModel: 'dgx-cost-test',
      enabled: true,
      apiKey: 'dgx-cost-test-key',
    });
    runCli(db, ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-test-cost-failed'], env);
    deployment(tenant.tenantId, 'openai', 'cost-failed', 'gpt-failed-cost');
    deployment(tenant.tenantId, 'openai', 'cost-empty', 'gpt-failed-empty');

    registerStoredPrice({
      provider: 'anthropic',
      model: 'claude-cost-test',
      status: 'unverified',
      inputRate: '0.03',
      outputRate: '0.02',
      cacheReadRate: '0.001',
      cacheWriteRate: '0.015',
    });
    registerStoredPrice({
      provider: 'vertex',
      model: 'gemini-cost-test',
      inputRate: '1',
      outputRate: '1',
      effectiveAt: ago(5_000),
    });
    const regionId = registerStoredPrice({
      provider: 'vertex',
      model: 'gemini-cost-test',
      region: 'us-central1',
      inputRate: '0.01',
      outputRate: '0.04',
      cacheReadRate: '0.001',
      thinkingRate: '0.02',
      effectiveAt: ago(180_000),
    });
    const deepinfraId = registerStoredPrice({
      provider: 'openrouter',
      model: 'route-cost-test',
      servingProvider: 'deepinfra',
      inputRate: '0.3',
      outputRate: '0.4',
      effectiveAt: ago(180_000),
    });
    registerStoredPrice({
      provider: 'openrouter',
      model: 'route-cost-test',
      servingProvider: 'together',
      inputRate: '1',
      outputRate: '2',
      effectiveAt: ago(5_000),
    });
    registerStoredPrice({
      provider: 'dgx',
      model: 'dgx-cost-test',
      inputRate: '0.01',
      outputRate: '0.01',
      allocatedRate: '0.5',
    });
    registerStoredPrice({
      provider: 'openai',
      model: 'gpt-failed-cost',
      inputRate: '0.000003',
      outputRate: '0.000015',
    });
    const emptyPriceId = registerStoredPrice({
      provider: 'openai',
      model: 'gpt-failed-empty',
      inputRate: '0.2',
      outputRate: '0.4',
    });

    const anthropicUsage: StoredUsage = {
      ...blankUsage(),
      promptTokens: 20,
      completionTokens: 2,
      totalTokens: 22,
      uncachedInputTokens: 10,
      cacheCreationInputTokens: 4,
      cacheReadInputTokens: 6,
    };
    const vertexUsage: StoredUsage = {
      ...blankUsage(),
      promptTokens: 100,
      completionTokens: 4,
      totalTokens: 112,
      uncachedInputTokens: 75,
      cacheReadInputTokens: 25,
      thoughtsTokens: 8,
    };
    const anthropic = await storeAttempt(tenant.tenantId, 'cost-anthropic', {
      status: 'succeeded',
      errorCode: null,
      usage: anthropicUsage,
    });
    expect(anthropic).toMatchObject(
      calculateCost({
        provider: 'anthropic',
        usage: anthropicUsage,
        price: {
          id: anthropic.priceVersionId ?? '',
          provider: 'anthropic',
          model: 'claude-cost-test',
          region: null,
          serviceTier: null,
          servingProvider: null,
          effectiveAt: '2024-01-01T00:00:00.000Z',
          createdAt: '2024-01-01T00:00:00.000Z',
          priceSource: 'fixture',
          verificationStatus: 'unverified',
          currency: 'USD',
          inputRate: '0.03',
          outputRate: '0.02',
          cacheReadRate: '0.001',
          cacheWriteRate: '0.015',
          thinkingRate: null,
          requestFee: null,
          allocatedRate: null,
        },
      }),
    );
    expect(anthropic.costStatus).toBe('provisional');
    expect(anthropic.amount).toBe('0.406');

    const vertex = await storeAttempt(tenant.tenantId, 'cost-vertex', {
      status: 'succeeded',
      errorCode: null,
      usage: vertexUsage,
    });
    expect(vertex.amount).toBe('1.095');
    expect(vertex.costStatus).toBe('estimated');
    expect(vertex.priceVersionId).toBe(regionId);

    const routed = await storeAttempt(tenant.tenantId, 'cost-openrouter', {
      status: 'succeeded',
      errorCode: null,
      usage: { ...blankUsage(), promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      servingProvider: 'deepinfra',
    });
    expect(routed.amount).toBe('1');
    expect(routed.priceVersionId).toBe(deepinfraId);

    const dgx = await storeAttempt(tenant.tenantId, 'cost-dgx', {
      status: 'succeeded',
      errorCode: null,
      usage: { ...blankUsage(), promptTokens: 11, completionTokens: 7, totalTokens: 40 },
    });
    expect(dgx.amount).toBe('0.18');
    expect(dgx.allocatedAmount).toBe('9');
    expect(dgx.allocatedStatus).toBe('estimated');

    const failed = await storeAttempt(tenant.tenantId, 'cost-failed', {
      status: 'failed',
      errorCode: 'upstream_error',
      usage: { ...blankUsage(), promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    });
    expect(failed.amount).toBe('0.0105');
    expect(failed.costStatus).toBe('estimated');
    const empty = await storeAttempt(tenant.tenantId, 'cost-empty', {
      status: 'failed',
      errorCode: 'upstream_error',
      usage: blankUsage(),
    });
    expect(empty.costStatus).toBe('unknown');
    expect(empty.amount).toBeNull();
    expect(empty.priceVersionId).toBe(emptyPriceId);

    const ctx = await createTestApp(db, { inferenceEnabled: false, credentialKey });
    pools.push(ctx.authPool, ctx.runtimePool);
    const report = await ctx.app.inject({
      method: 'GET',
      url: costUrl(''),
      headers: headers(tenant.tenantId, tenant.secret),
    });
    expect(report.statusCode).toBe(200);
    const body = report.json() as CostBody;
    expect(group(body, 'claude-cost-test').external.provisional).toEqual({ attempts: 1, amount: '0.406' });
    expect(group(body, 'gemini-cost-test').external.estimated).toEqual({ attempts: 1, amount: '1.095' });
    expect(group(body, 'route-cost-test').external.estimated).toEqual({ attempts: 1, amount: '1' });
    expect(group(body, 'dgx-cost-test').external.estimated).toEqual({ attempts: 1, amount: '0.18' });
    expect(group(body, 'dgx-cost-test').dgxAllocated.estimated).toEqual({ attempts: 1, amount: '9' });
    expect(group(body, 'gpt-failed-cost').external.estimated).toEqual({ attempts: 1, amount: '0.0105' });
    expect(group(body, 'gpt-failed-empty').external.unknown).toEqual({ attempts: 1, amount: null });
    expect(body.external.estimated.amount).toBe('2.2855');
    expect(body.external.provisional.amount).toBe('0.406');
    expect(body.external.unknown).toEqual({ attempts: 1, amount: null });
    expect(body.dgxAllocated.estimated).toEqual({ attempts: 1, amount: '9' });
    expect(body.external.estimated.amount).not.toBe('11.2855');
    console.log(`COST_API_PROVIDERS ${JSON.stringify(body)}`);

    const vertexOnly = await ctx.app.inject({
      method: 'GET',
      url: costUrl('&provider=vertex&deployment=cost-vertex&model=gemini-cost-test'),
      headers: headers(tenant.tenantId, tenant.secret),
    });
    const vertexBody = vertexOnly.json() as CostBody;
    expect(vertexBody.byProvider.map((row) => row.model)).toEqual(['gemini-cost-test']);
    expect(vertexBody.external.estimated.amount).toBe('1.095');
    expect(vertexBody.dgxAllocated.estimated.attempts).toBe(0);

    const outsider = provisionTenant(db, 'Cost Outsider');
    const hidden = await ctx.app.inject({
      method: 'GET',
      url: costUrl(''),
      headers: headers(outsider.tenantId, outsider.secret),
    });
    const hiddenBody = hidden.json() as CostBody;
    expect(hiddenBody.byProvider).toEqual([]);
    expect(attempts(hiddenBody.external)).toBe(0);
    expect(JSON.stringify(hiddenBody)).not.toContain('claude-cost-test');
    expect(JSON.stringify(body)).not.toContain(outsider.tenantId);
  });

  it('keeps concurrent tenant cost queries on their own rows', async () => {
    const mock = await startMockUpstream();
    const alpha = provisionTenant(db, 'Cost Alpha');
    const beta = provisionTenant(db, 'Cost Beta');
    registerInference(db, {
      tenantId: alpha.tenantId,
      apiKey: 'sk-test-cost-alpha',
      deployment: 'cost-alpha',
      upstreamModel: 'gpt-cost-alpha',
    });
    registerInference(db, {
      tenantId: beta.tenantId,
      apiKey: 'sk-test-cost-beta',
      deployment: 'cost-beta',
      upstreamModel: 'gpt-cost-beta',
    });
    registerStoredPrice({ provider: 'openai', model: 'gpt-cost-alpha', inputRate: '0.1', outputRate: '0.2' });
    registerStoredPrice({ provider: 'openai', model: 'gpt-cost-beta', inputRate: '0.3', outputRate: '0.4' });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    pools.push(ctx.authPool, ctx.runtimePool);
    try {
      const [alphaChat, betaChat] = await Promise.all([
        ctx.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { ...headers(alpha.tenantId, alpha.secret), 'content-type': 'application/json' },
          payload: chatPayload('cost-alpha', 'alpha-cost'),
        }),
        ctx.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: { ...headers(beta.tenantId, beta.secret), 'content-type': 'application/json' },
          payload: chatPayload('cost-beta', 'beta-cost'),
        }),
      ]);
      expect(alphaChat.statusCode).toBe(200);
      expect(betaChat.statusCode).toBe(200);
      expect(alphaChat.json().usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      expect(betaChat.json().cost).toBeUndefined();

      const [alphaReport, betaReport] = await Promise.all([
        ctx.app.inject({
          method: 'GET',
          url: costUrl('&provider=openai'),
          headers: headers(alpha.tenantId, alpha.secret),
        }),
        ctx.app.inject({
          method: 'GET',
          url: costUrl('&provider=openai&deployment=cost-beta&model=gpt-cost-beta'),
          headers: headers(beta.tenantId, beta.secret),
        }),
      ]);
      const alphaBody = alphaReport.json() as CostBody;
      const betaBody = betaReport.json() as CostBody;
      expect(alphaBody.external.estimated).toEqual({ attempts: 1, amount: '0.7' });
      expect(alphaBody.byProvider.map((row) => row.deployment)).toEqual(['cost-alpha']);
      expect(betaBody.external.estimated).toEqual({ attempts: 1, amount: '1.7' });
      expect(betaBody.byProvider.map((row) => row.model)).toEqual(['gpt-cost-beta']);
      expect(JSON.stringify(alphaBody)).not.toContain('cost-beta');
      expect(JSON.stringify(alphaBody)).not.toContain('gpt-cost-beta');
      expect(JSON.stringify(betaBody)).not.toContain('cost-alpha');
      expect(JSON.stringify(betaBody)).not.toContain('gpt-cost-alpha');
      console.log(`COST_ISOLATION ${JSON.stringify({ alpha: alphaBody, beta: betaBody })}`);

      const crossed = await ctx.app.inject({
        method: 'GET',
        url: costUrl('&deployment=cost-beta'),
        headers: headers(alpha.tenantId, alpha.secret),
      });
      expect((crossed.json() as CostBody).byProvider).toEqual([]);
      const runtime = createPool(configFor(db), 'runtime', undefined, 1);
      pools.push(runtime);
      const unscoped = await runtime.query('SELECT attempt_id FROM attempt_costs');
      expect(unscoped.rows).toEqual([]);
      await withTenant(runtime, alpha.tenantId, async (client: PoolClient) => {
        const names = await client.query<{ name: string }>('SELECT name FROM model_deployments');
        expect(names.rows.map((row) => row.name)).toEqual(['cost-alpha']);
      });
    } finally {
      await mock.close();
    }
  });

  it('keeps price versions immutable and applies the additive migration', async () => {
    const sql = readFileSync(join(projectRoot, 'migrations', '012_cost_accounting.sql'), 'utf8');
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).toContain('011_private_endpoint.sql');
    const admin = adminPool(db);
    const migrator = createPool(configFor(db), 'migrator', undefined, 1);
    pools.push(admin, migrator);
    const versions = await admin.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    const names = versions.rows.map((row) => row.version);
    expect(names).toContain('011_private_endpoint.sql');
    expect(names).toContain('012_cost_accounting.sql');
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'price_versions'
       ORDER BY column_name`,
    );
    const columnNames = columns.rows.map((row) => row.column_name);
    for (const name of [
      'allocated_rate',
      'cache_read_rate',
      'cache_write_rate',
      'effective_at',
      'input_rate',
      'output_rate',
      'price_source',
      'region',
      'request_fee',
      'service_tier',
      'serving_provider',
      'thinking_rate',
      'verification_status',
    ]) {
      expect(columnNames).toContain(name);
    }
    const tierColumn = await admin.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'model_deployments' AND column_name = 'service_tier'`,
    );
    expect(tierColumn.rowCount).toBe(1);
    await expect(
      migrator.query(
        `SELECT * FROM insert_price_version(
           'openai', 'rate-reject-cost', NULL, NULL, NULL, now(), 'fixture', 'verified',
           '0.0000000000001', NULL, NULL, NULL, NULL, NULL, NULL
         )`,
      ),
    ).rejects.toThrow(/rate is invalid/i);
    const storedId = registerStoredPrice({
      provider: 'openai',
      model: 'immutable-cost-test',
      inputRate: '0.1',
      outputRate: '0.2',
    });
    await expect(admin.query('UPDATE price_versions SET input_rate = 9 WHERE id = $1', [storedId])).rejects.toThrow(
      /price version is immutable/i,
    );
    await expect(admin.query('DELETE FROM price_versions WHERE id = $1', [storedId])).rejects.toThrow(
      /price version is immutable/i,
    );
    const stray = spawnSync(process.execPath, [cliEntry, 'provision-tenant', '--name', 'Cost Stray', '--input-rate', '0.1'], {
      cwd: projectRoot,
      env: serviceEnv(db, cliEnv()),
      encoding: 'utf8',
    });
    expect(stray.status).not.toBe(0);
    expect(stray.stderr).toContain('invalid command arguments');
    const badRate = spawnSync(
      process.execPath,
      [
        cliEntry,
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        'bad-rate-cost',
        '--effective-at',
        new Date().toISOString(),
        '--source',
        'fixture',
        '--status',
        'verified',
        '--input-rate',
        '1e-3',
      ],
      { cwd: projectRoot, env: serviceEnv(db, cliEnv()), encoding: 'utf8' },
    );
    expect(badRate.status).not.toBe(0);
    expect(badRate.stderr).toContain('price arguments are invalid');
    console.log('COST_MIGRATION 012_cost_accounting.sql applied and price versions reject updates');
  });

  it('does not change a chat when cost recording fails', async () => {
    const mock = await startMockUpstream();
    const tenant = provisionTenant(db, 'Cost Failure');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-cost-failure',
      deployment: 'cost-failure',
      upstreamModel: 'gpt-cost-failure',
    });
    registerStoredPrice({
      provider: 'openai',
      model: 'gpt-cost-failure',
      inputRate: '0.1',
      outputRate: '0.2',
    });
    const admin = adminPool(db);
    pools.push(admin);
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    pools.push(ctx.authPool, ctx.runtimePool);
    try {
      await admin.query('REVOKE INSERT ON attempt_costs FROM llm_runtime');
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { ...headers(tenant.tenantId, tenant.secret), 'content-type': 'application/json' },
        payload: chatPayload('cost-failure', 'still-served'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
      expect(response.json().cost).toBeUndefined();
      expect(ctx.lines.join('\n')).toContain('attempt cost was not recorded');
      expect(ctx.lines.join('\n')).not.toContain('sk-test-cost-failure');
      const stored = await admin.query<{ status: string; cost_status: string | null }>(
        `SELECT a.status, ac.cost_status
         FROM model_attempts a
         LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
         WHERE a.tenant_id = $1`,
        [tenant.tenantId],
      );
      expect(stored.rows).toEqual([{ status: 'succeeded', cost_status: null }]);
      console.log('COST_API_FAILURE chat status 200 and the attempt stayed stored');
    } finally {
      await admin.query('GRANT INSERT ON attempt_costs TO llm_runtime');
      await mock.close();
    }
  });
});

