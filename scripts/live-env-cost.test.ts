import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { calculateCost, canonicalDecimal, type PriceCandidate, type StoredUsage } from '../src/inference/cost.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli } from '../test/helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKey, provisionTenant, registerAnthropic, registerInference } from '../test/inference-support.js';

type LiveEnv = {
  openaiKey: string;
  anthropicKey: string;
  anthropicEndpoint: string;
};

function loadLiveEnv(): LiveEnv {
  const text = readFileSync(join(projectRoot, '.env.live'), 'utf8');
  const values = new Map<string, string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const name = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(name, value);
  }
  return {
    openaiKey: values.get('OPENAI_API_KEY') ?? '',
    anthropicKey: values.get('ANTHROPIC_API_KEY') ?? '',
    anthropicEndpoint: values.get('ANTHROPIC_ENDPOINT') ?? 'https://api.anthropic.com',
  };
}

function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length > 0) safe = safe.split(secret).join('[redacted]');
  }
  return safe;
}

describe('live env cost', () => {
  const db = loadTestDatabase();
  const pools: Array<{ end: () => Promise<unknown> }> = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('costs one OpenAI call and one Anthropic call from the local keys', async () => {
    const live = loadLiveEnv();
    const secrets = [live.openaiKey, live.anthropicKey];
    expect(live.openaiKey.length).toBeGreaterThan(0);
    expect(live.anthropicKey.length).toBeGreaterThan(0);
    const tenant = provisionTenant(db, 'Live Env Cost');
    const cli = (args: string[]): Record<string, unknown> => {
      try {
        return runCli(db, args, cliEnv()) as Record<string, unknown>;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'cli failed';
        throw new Error(redact(message, secrets));
      }
    };
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: live.openaiKey,
      deployment: 'live-openai',
      upstreamModel: 'gpt-4o-mini',
      timeoutMs: 45000,
      capabilities: 'temperature,max_completion_tokens',
    });
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: live.anthropicKey,
      endpoint: live.anthropicEndpoint,
      deployment: 'live-anthropic',
      upstreamModel: 'claude-sonnet-4-5',
      timeoutMs: 45000,
      defaultMaxOutputTokens: 32,
    });
    const effectiveAt = new Date(Date.now() - 60_000).toISOString();
    const registerPrice = (provider: string, model: string): string => {
      const created = cli([
        'register-price',
        '--provider',
        provider,
        '--upstream-model',
        model,
        '--effective-at',
        effectiveAt,
        '--source',
        'live-env',
        '--status',
        'verified',
        '--input-rate',
        '0.000001',
        '--output-rate',
        '0.000002',
        '--cache-read-rate',
        '0.0000005',
        '--cache-write-rate',
        '0.0000015',
        '--thinking-rate',
        '0.000003',
      ]);
      if (typeof created.id !== 'string') throw new Error('price was not stored');
      return created.id;
    };
    const openaiPrice = registerPrice('openai', 'gpt-4o-mini');
    const anthropicPrice = registerPrice('anthropic', 'claude-sonnet-4-5');
    const ctx = await createTestApp(db, { inferenceEnabled: true, credentialKey });
    pools.push(ctx.authPool, ctx.runtimePool);
    const from = new Date(Date.now() - 180_000).toISOString();
    const to = new Date(Date.now() + 180_000).toISOString();
    const headers = {
      'content-type': 'application/json',
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
    };
    const calls = [
      { deployment: 'live-openai', model: 'gpt-4o-mini', provider: 'openai', priceId: openaiPrice },
      { deployment: 'live-anthropic', model: 'claude-sonnet-4-5', provider: 'anthropic', priceId: anthropicPrice },
    ] as const;
    for (const call of calls) {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload: chatPayload(call.deployment, 'Reply with the word ok.', { max_completion_tokens: 16 }),
      });
      const body = response.json() as { usage?: unknown; error?: { code?: string } };
      if (response.statusCode !== 200) {
        throw new Error(redact(`${call.provider} status ${response.statusCode} code ${body.error?.code ?? 'none'}`, secrets));
      }
      expect(body.usage).toEqual(expect.objectContaining({
        prompt_tokens: expect.any(Number),
        completion_tokens: expect.any(Number),
        total_tokens: expect.any(Number),
      }));
      expect(body).not.toHaveProperty('cost');
    }
    const logs = redact(ctx.lines.join('\n'), secrets);
    expect(logs).not.toContain(live.openaiKey);
    expect(logs).not.toContain(live.anthropicKey);
    const admin = adminPool(db);
    pools.push(admin);
    const stored = await admin.query<{
      provider: string;
      deployment: string;
      model: string;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      uncached_input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
      thoughts_tokens: number | null;
      cost_status: string;
      amount: string | null;
      price_version_id: string;
    }>(
      `SELECT c2.provider,
              d.name AS deployment,
              a.upstream_model AS model,
              a.prompt_tokens,
              a.completion_tokens,
              a.total_tokens,
              a.uncached_input_tokens,
              a.cache_creation_input_tokens,
              a.cache_read_input_tokens,
              a.thoughts_tokens,
              cost.cost_status,
              cost.amount::text AS amount,
              cost.price_version_id
         FROM model_attempts a
         JOIN proxy_requests r ON r.tenant_id = a.tenant_id AND r.id = a.request_id
         JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
         JOIN provider_connections c2 ON c2.tenant_id = r.tenant_id AND c2.id = r.connection_id
         JOIN attempt_costs cost ON cost.tenant_id = a.tenant_id AND cost.attempt_id = a.id
        WHERE a.tenant_id = $1
        ORDER BY a.created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows).toHaveLength(2);
    const reports = stored.rows.map((row) => {
      const usage: StoredUsage = {
        promptTokens: row.prompt_tokens,
        completionTokens: row.completion_tokens,
        totalTokens: row.total_tokens,
        uncachedInputTokens: row.uncached_input_tokens,
        cacheCreationInputTokens: row.cache_creation_input_tokens,
        cacheReadInputTokens: row.cache_read_input_tokens,
        thoughtsTokens: row.thoughts_tokens,
      };
      const price: PriceCandidate = {
        id: row.price_version_id,
        provider: row.provider,
        model: row.model,
        region: null,
        serviceTier: null,
        servingProvider: null,
        effectiveAt,
        createdAt: effectiveAt,
        priceSource: 'live-env',
        verificationStatus: 'verified',
        currency: 'USD',
        inputRate: '0.000001',
        outputRate: '0.000002',
        cacheReadRate: '0.0000005',
        cacheWriteRate: '0.0000015',
        thinkingRate: '0.000003',
        requestFee: null,
        allocatedRate: null,
      };
      const expected = calculateCost({
        provider: row.provider as 'openai' | 'anthropic',
        usage,
        price,
      });
      expect(row.cost_status).toBe(expected.costStatus);
      expect(row.amount === null ? null : canonicalDecimal(row.amount)).toBe(expected.amount);
      expect(row.cost_status).toBe('estimated');
      return {
        provider: row.provider,
        deployment: row.deployment,
        model: row.model,
        usage,
        costStatus: row.cost_status,
        amount: row.amount === null ? null : canonicalDecimal(row.amount),
      };
    });
    const report = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/costs?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers,
    });
    expect(report.statusCode).toBe(200);
    const costBody = report.json() as { byProvider: Array<{ provider: string; deployment: string; model: string }> };
    expect(costBody.byProvider.map((row) => row.deployment).sort()).toEqual(['live-anthropic', 'live-openai']);
    console.log(`LIVE_ENV_COST ${JSON.stringify({ calls: reports, currency: 'USD' })}`);
  });
});
