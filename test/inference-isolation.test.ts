import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { configFor, createTestApp, loadTestDatabase } from './helpers.js';
import {
  adminPool,
  chatPayload,
  credentialKey,
  provisionTenant,
  registerInference,
  resolvedUpstream,
} from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';

describe('inference tenant isolation', () => {
  const db = loadTestDatabase();
  const pools: { end: () => Promise<unknown> }[] = [];

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('keeps two tenants on different backends, aliases, metrics, and logs', async () => {
    const mock = await startMockUpstream((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; messages?: Array<{ content?: string }> };
      const content = parsed.messages?.[0]?.content ?? '';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-tenant',
          object: 'chat.completion',
          created: 10,
          model: parsed.model,
          choices: [{ index: 0, message: { role: 'assistant', content: `saw ${content}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
        }),
      );
    });
    const alpha = provisionTenant(db, 'Infer Alpha');
    const beta = provisionTenant(db, 'Infer Beta');
    registerInference(db, {
      tenantId: alpha.tenantId,
      apiKey: 'sk-test-isolation-alpha',
      deployment: 'alpha-chat',
      upstreamModel: 'gpt-alpha',
    });
    registerInference(db, {
      tenantId: beta.tenantId,
      apiKey: 'sk-test-isolation-beta',
      deployment: 'beta-chat',
      upstreamModel: 'gpt-beta',
    });
    expect(await resolvedUpstream(db, alpha.tenantId, 'auto')).toBe('gpt-alpha');
    expect(await resolvedUpstream(db, beta.tenantId, 'auto')).toBe('gpt-beta');

    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    pools.push(ctx.authPool, ctx.runtimePool);
    const admin = adminPool(db);
    pools.push(admin);

    const alphaResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': alpha.tenantId,
        authorization: `Bearer ${alpha.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'alpha-only-prompt'),
    });
    const betaResponse = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': beta.tenantId,
        authorization: `Bearer ${beta.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'beta-only-prompt'),
    });
    expect(alphaResponse.statusCode).toBe(200);
    expect(alphaResponse.json().model).toBe('gpt-alpha');
    expect(betaResponse.json().model).toBe('gpt-beta');
    expect(alphaResponse.json().choices[0].message.content).not.toContain('beta-only-prompt');
    const authorizations = mock.hits.map((hit) => hit.authorization);
    expect(authorizations).toContain('Bearer sk-test-isolation-alpha');
    expect(authorizations).toContain('Bearer sk-test-isolation-beta');

    const crossed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': alpha.tenantId,
        authorization: `Bearer ${alpha.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('beta-chat', 'should-not-run'),
    });
    expect(crossed.statusCode).toBe(404);
    expect(mock.hits).toHaveLength(2);

    const callerUrl = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-tenant-id': alpha.tenantId,
        authorization: `Bearer ${alpha.secret}`,
        'content-type': 'application/json',
      },
      payload: chatPayload('auto', 'url-prompt', { base_url: 'http://evil.example/v1' }),
    });
    expect(callerUrl.statusCode).toBe(400);
    expect(mock.hits).toHaveLength(2);

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const alphaMetrics = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { 'x-tenant-id': alpha.tenantId, authorization: `Bearer ${alpha.secret}` },
    });
    const betaMetrics = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: { 'x-tenant-id': beta.tenantId, authorization: `Bearer ${beta.secret}` },
    });
    expect(alphaMetrics.json().requests.total).toBe(1);
    expect(betaMetrics.json().requests.total).toBe(1);
    expect(alphaMetrics.json().usage.promptTokens).toBe(4);

    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    pools.push(runtime);
    await withTenant(runtime, alpha.tenantId, async (client) => {
      const deployments = await client.query<{ name: string }>('SELECT name FROM model_deployments');
      expect(deployments.rows.map((row) => row.name)).toEqual(['alpha-chat']);
      const requests = await client.query<{ requested_model: string }>('SELECT requested_model FROM proxy_requests');
      expect(requests.rows.every((row) => row.requested_model !== 'beta-chat')).toBe(true);
      await expect(client.query('SELECT protected_credential FROM provider_connections')).rejects.toThrow(
        /permission denied/i,
      );
    });
    const unscoped = await runtime.query('SELECT id FROM proxy_requests');
    expect(unscoped.rows).toEqual([]);

    const forced = await admin.query<{ relname: string; relforcerowsecurity: boolean }>(
      `SELECT relname, relforcerowsecurity
       FROM pg_class
       WHERE relname IN (
         'provider_connections', 'model_deployments', 'model_aliases', 'proxy_requests', 'model_attempts'
       )
       ORDER BY relname`,
    );
    expect(forced.rows.every((row) => row.relforcerowsecurity)).toBe(true);

    const logText = ctx.lines.join('\n');
    expect(logText).not.toContain('sk-test-isolation-alpha');
    expect(logText).not.toContain('sk-test-isolation-beta');
    expect(logText).not.toContain(alpha.secret);
    expect(logText).not.toContain('alpha-only-prompt');
    expect(logText).not.toContain('aes-256-gcm$');
    await ctx.app.close();
    await mock.close();
  });
});
