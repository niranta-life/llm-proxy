import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { configFor, createTestApp, freePort, loadTestDatabase, runCli, type TestDatabase } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  provisionTenant,
  registerAnthropic,
  registerInference,
} from './inference-support.js';
import { anthropicMessage, startMockAnthropic, type AnthropicHit } from './mock-anthropic.js';
import { startMockUpstream } from './mock-openai.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

async function boot(
  db: TestDatabase,
  input: {
    name: string;
    openaiKey: string;
    anthropicKey: string;
    openaiDeployment?: string;
    anthropicDeployment?: string;
    openaiModel?: string;
    anthropicModel?: string;
    timeoutMs?: number;
    capabilities?: string;
    anthropicEnabled?: boolean;
    workspaceId?: string;
    defaultMaxOutputTokens?: number;
    anthropicHandle?: (hit: AnthropicHit, request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void;
  },
) {
  const openai = await startMockUpstream();
  const anthropic = await startMockAnthropic(input.anthropicHandle);
  const tenant = provisionTenant(db, input.name);
  registerInference(db, {
    tenantId: tenant.tenantId,
    apiKey: input.openaiKey,
    deployment: input.openaiDeployment ?? 'openai-chat',
    upstreamModel: input.openaiModel ?? 'gpt-tenant',
  });
  registerAnthropic(db, {
    tenantId: tenant.tenantId,
    apiKey: input.anthropicKey,
    endpoint: anthropic.origin,
    deployment: input.anthropicDeployment ?? 'claude-chat',
    upstreamModel: input.anthropicModel ?? 'claude-tenant',
    timeoutMs: input.timeoutMs,
    capabilities: input.capabilities,
    enabled: input.anthropicEnabled,
    workspaceId: input.workspaceId,
    defaultMaxOutputTokens: input.defaultMaxOutputTokens,
  });
  const ctx = await createTestApp(db, {
    inferenceEnabled: true,
    upstreamBaseUrl: openai.baseUrl,
    credentialKey,
  });
  const admin = adminPool(db);
  closers.push(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
    await anthropic.close();
  });
  return { openai, anthropic, tenant, ctx, admin };
}

describe('Anthropic integration', () => {
  const db = loadTestDatabase();

  it('keeps two providers and two tenants on their own credentials', async () => {
    const openai = await startMockUpstream();
    const anthropic = await startMockAnthropic();
    const alpha = provisionTenant(db, 'Provider Alpha');
    const beta = provisionTenant(db, 'Provider Beta');
    registerInference(db, {
      tenantId: alpha.tenantId,
      apiKey: 'sk-test-alpha-openai',
      deployment: 'alpha-openai',
      upstreamModel: 'gpt-alpha',
    });
    registerAnthropic(db, {
      tenantId: alpha.tenantId,
      apiKey: 'sk-ant-alpha',
      endpoint: anthropic.origin,
      deployment: 'alpha-claude',
      upstreamModel: 'claude-alpha',
      workspaceId: 'ws-alpha',
    });
    registerInference(db, {
      tenantId: beta.tenantId,
      apiKey: 'sk-test-beta-openai',
      deployment: 'beta-openai',
      upstreamModel: 'gpt-beta',
    });
    registerAnthropic(db, {
      tenantId: beta.tenantId,
      apiKey: 'sk-ant-beta',
      endpoint: anthropic.origin,
      deployment: 'beta-claude',
      upstreamModel: 'claude-beta',
      workspaceId: 'ws-beta',
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
    const admin = adminPool(db);
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await runtime.end();
      await admin.end();
      await openai.close();
      await anthropic.close();
    });

    const alphaOpenAi = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(alpha.tenantId, alpha.secret),
      payload: chatPayload('alpha-openai', 'alpha-openai-prompt'),
    });
    const alphaClaude = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(alpha.tenantId, alpha.secret),
      payload: chatPayload('alpha-claude', 'alpha-claude-prompt', {
        messages: [
          { role: 'system', content: 'alpha-system' },
          { role: 'user', content: 'alpha-claude-prompt' },
        ],
        max_completion_tokens: 24,
        temperature: 0.2,
      }),
    });
    const betaClaude = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(beta.tenantId, beta.secret),
      payload: chatPayload('beta-claude', 'beta-claude-prompt'),
    });
    expect(alphaOpenAi.statusCode).toBe(200);
    expect(alphaOpenAi.json().model).toBe('gpt-alpha');
    expect(alphaClaude.statusCode).toBe(200);
    expect(alphaClaude.json().model).toBe('claude-alpha');
    expect(alphaClaude.json().choices[0].finish_reason).toBe('stop');
    expect(betaClaude.json().model).toBe('claude-beta');
    expect(openai.hits.map((hit) => hit.authorization)).toEqual(['Bearer sk-test-alpha-openai']);
    expect(anthropic.hits.map((hit) => hit.apiKey)).toEqual(['sk-ant-alpha', 'sk-ant-beta']);
    expect(anthropic.hits.map((hit) => hit.workspaceId)).toEqual(['ws-alpha', 'ws-beta']);
    const alphaBody = JSON.parse(anthropic.hits[0]?.body ?? '{}') as {
      model?: string;
      system?: string;
      max_tokens?: number;
      temperature?: number;
    };
    expect(alphaBody.model).toBe('claude-alpha');
    expect(alphaBody.system).toBe('alpha-system');
    expect(alphaBody.max_tokens).toBe(24);
    expect(alphaBody.temperature).toBe(0.2);

    const crossed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(alpha.tenantId, alpha.secret),
      payload: chatPayload('beta-claude', 'should-not-run'),
    });
    expect(crossed.statusCode).toBe(404);
    expect(crossed.json().error.code).toBe('model_not_found');
    expect(anthropic.hits).toHaveLength(2);
    expect(openai.hits).toHaveLength(1);

    await withTenant(runtime, alpha.tenantId, async (client) => {
      const names = await client.query<{ name: string }>('SELECT name FROM model_deployments ORDER BY name');
      expect(names.rows.map((row) => row.name)).toEqual(['alpha-claude', 'alpha-openai']);
    });
    const unscoped = await runtime.query('SELECT id FROM provider_connections');
    expect(unscoped.rows).toEqual([]);

    const stored = await admin.query<{ protected_credential: string; endpoint: string | null }>(
      `SELECT protected_credential, endpoint
       FROM provider_connections
       WHERE tenant_id = $1
       ORDER BY provider`,
      [alpha.tenantId],
    );
    expect(stored.rows[0]?.endpoint).toBe(anthropic.origin);
    expect(stored.rows[1]?.endpoint).toBeNull();
    for (const row of stored.rows) {
      expect(row.protected_credential.startsWith('aes-256-gcm$')).toBe(true);
      expect(row.protected_credential).not.toContain('sk-ant-alpha');
      expect(row.protected_credential).not.toContain('sk-test-alpha-openai');
    }
    const logText = ctx.lines.join('\n');
    expect(logText).not.toContain('sk-ant-alpha');
    expect(logText).not.toContain('sk-ant-beta');
    expect(logText).not.toContain('alpha-claude-prompt');
    expect(logText).not.toContain(alpha.secret);
  });

  it('resolves auto and an explicit deployment without changing the explicit model', async () => {
    const harness = await boot(db, {
      name: 'Alias Tenant',
      openaiKey: 'sk-test-alias-openai',
      anthropicKey: 'sk-ant-alias',
      openaiDeployment: 'alias-openai',
      anthropicDeployment: 'alias-claude',
      openaiModel: 'gpt-alias',
      anthropicModel: 'claude-alias',
    });
    const before = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', 'alias-openai-prompt'),
    });
    expect(before.json().model).toBe('gpt-alias');
    expect(harness.anthropic.hits).toHaveLength(0);

    runCli(
      db,
      ['set-alias', '--tenant-id', harness.tenant.tenantId, '--alias', 'auto', '--deployment', 'alias-claude'],
      cliEnv(),
    );
    const aliased = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', 'alias-claude-prompt'),
    });
    const forced = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('alias-openai', 'forced-openai-prompt'),
    });
    expect(aliased.statusCode).toBe(200);
    expect(aliased.json().model).toBe('claude-alias');
    expect(forced.json().model).toBe('gpt-alias');
    expect(JSON.parse(harness.anthropic.hits[0]?.body ?? '{}').model).toBe('claude-alias');
    expect(harness.anthropic.hits).toHaveLength(1);
    expect(harness.openai.hits).toHaveLength(2);
    expect(harness.openai.hits.map((hit) => JSON.parse(hit.body).model)).toEqual(['gpt-alias', 'gpt-alias']);
  });

  it('records the provider request, stop reason, and cache categories', async () => {
    const prompt = 'unique-anthropic-persist-zeta';
    const harness = await boot(db, {
      name: 'Persist Tenant',
      openaiKey: 'sk-test-persist-openai',
      anthropicKey: 'sk-ant-persist',
      defaultMaxOutputTokens: 48,
    });
    const versions = await harness.admin.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version');
    expect(versions.rows.map((row) => row.version)).toEqual([
      '001_schema.sql',
      '002_security.sql',
      '003_inference.sql',
      '004_anthropic.sql',
      '005_openai_streaming.sql',
      '006_anthropic_streaming.sql',
      '007_stream_interrupted.sql',
      '008_provider_registry.sql',
      '009_vertex_provider.sql',
      '010_compatible_providers.sql',
      '011_private_endpoint.sql',
      '012_cost_accounting.sql',
      '013_execution_policy.sql',
      '014_provider_breaker.sql',
      '015_tenant_limits.sql',
      '016_fallback_policy.sql',
      '017_request_features.sql',
      '018_sample_capture.sql',
      '019_sample_retention.sql',
      '020_stream_samples.sql',
      '021_evaluation_orchestration.sql',
      '022_evaluation_replay.sql',
      '023_evaluation_validators.sql',
      '024_evaluation_judgments.sql',
      '025_evaluation_schedules.sql',
      '026_routing_policies.sql',
    ]);
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('claude-chat', prompt),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().usage).toEqual({ prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 });
    expect(JSON.parse(harness.anthropic.hits[0]?.body ?? '{}').max_tokens).toBe(48);
    const row = await harness.admin.query<{
      tenant_id: string;
      connection_id: string;
      deployment_id: string;
      upstream_model: string;
      provider_request_id: string;
      stop_reason: string;
      status: string;
      prompt_tokens: number;
      completion_tokens: number;
      uncached_input_tokens: number;
      cache_creation_input_tokens: number;
      cache_read_input_tokens: number;
      duration_ms: number;
    }>(
      `SELECT r.tenant_id, r.connection_id, r.deployment_id, a.upstream_model, a.provider_request_id,
              a.stop_reason, a.status, a.prompt_tokens, a.completion_tokens, a.uncached_input_tokens,
              a.cache_creation_input_tokens, a.cache_read_input_tokens, a.duration_ms
       FROM proxy_requests r
       JOIN model_attempts a ON a.request_id = r.id
       WHERE r.tenant_id = $1`,
      [harness.tenant.tenantId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      tenant_id: harness.tenant.tenantId,
      upstream_model: 'claude-tenant',
      provider_request_id: 'msg_test',
      stop_reason: 'end_turn',
      status: 'succeeded',
      prompt_tokens: 13,
      completion_tokens: 4,
      uncached_input_tokens: 10,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    });
    expect((row.rows[0]?.duration_ms ?? -1) >= 0).toBe(true);
    const leaked = await harness.admin.query<{ matches: number }>(
      `SELECT (
         (SELECT count(*) FROM proxy_requests WHERE requested_model LIKE $1) +
         (SELECT count(*) FROM model_attempts WHERE upstream_model LIKE $1 OR coalesce(error_code, '') LIKE $1
            OR coalesce(provider_request_id, '') LIKE $1 OR coalesce(stop_reason, '') LIKE $1)
       )::int AS matches`,
      [`%${prompt}%`],
    );
    expect(leaked.rows[0]?.matches).toBe(0);
    expect(harness.ctx.lines.join('\n')).not.toContain(prompt);
    expect(harness.ctx.lines.join('\n')).not.toContain('sk-ant-persist');
  });

  it('sums metrics across both providers for one tenant', async () => {
    const harness = await boot(db, {
      name: 'Metrics Tenant',
      openaiKey: 'sk-test-metrics-openai',
      anthropicKey: 'sk-ant-metrics',
      openaiDeployment: 'metrics-openai',
      anthropicDeployment: 'metrics-claude',
    });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    expect((await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('metrics-openai', 'metrics-openai-prompt'),
    })).statusCode).toBe(200);
    expect((await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('metrics-claude', 'metrics-claude-prompt'),
    })).statusCode).toBe(200);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const metrics = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers,
    });
    expect(metrics.statusCode).toBe(200);
    expect(metrics.json().requests).toMatchObject({ total: 2, succeeded: 2, failed: 0 });
    expect(metrics.json().usage).toMatchObject({ promptTokens: 16, completionTokens: 6, totalTokens: 22 });
    expect(JSON.stringify(metrics.json())).not.toContain('quality');
  });

  it('uses the rotated Anthropic credential on the next call only', async () => {
    const harness = await boot(db, {
      name: 'Rotate Tenant',
      openaiKey: 'sk-test-rotate-openai',
      anthropicKey: 'sk-ant-before',
    });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('claude-chat', 'rotate-before'),
    });
    runCli(
      db,
      ['set-anthropic-credential', '--tenant-id', harness.tenant.tenantId, '--api-key', 'sk-ant-after'],
      cliEnv(),
    );
    await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('claude-chat', 'rotate-after'),
    });
    expect(harness.anthropic.hits.map((hit) => hit.apiKey)).toEqual(['sk-ant-before', 'sk-ant-after']);
    expect(harness.openai.hits).toHaveLength(0);
    const stored = await harness.admin.query<{ protected_credential: string }>(
      `SELECT protected_credential FROM provider_connections WHERE tenant_id = $1 AND provider = 'anthropic'`,
      [harness.tenant.tenantId],
    );
    expect(stored.rows[0]?.protected_credential).not.toContain('sk-ant-after');
    expect(harness.ctx.lines.join('\n')).not.toContain('sk-ant-after');
  });

  it('rejects unsupported Anthropic values before any upstream call', async () => {
    const harness = await boot(db, {
      name: 'Reject Tenant',
      openaiKey: 'sk-test-reject-openai',
      anthropicKey: 'sk-ant-reject',
      capabilities: 'temperature,stop,max_completion_tokens,top_p,max_tokens',
    });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    const cases = [
      chatPayload('claude-chat', 'stream', { stream: true }),
      chatPayload('claude-chat', 'tools', { tools: [{ type: 'function', function: { name: 'lookup' } }] }),
      chatPayload('claude-chat', 'image', { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://example' } }] }] }),
      chatPayload('claude-chat', 'json', { response_format: { type: 'json_object' } }),
      chatPayload('claude-chat', 'later', { messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'later' }] }),
      chatPayload('claude-chat', 'developer', { messages: [{ role: 'developer', content: 'hidden' }] }),
      chatPayload('claude-chat', 'prefill', { messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'partial' }] }),
      chatPayload('claude-chat', 'sample', { top_p: 0.2 }),
      chatPayload('claude-chat', 'hot', { temperature: 1.4 }),
    ];
    for (const payload of cases) {
      const response = await harness.ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers,
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.type).toBe('invalid_request_error');
    }
    expect(harness.anthropic.hits).toHaveLength(0);
    expect(harness.openai.hits).toHaveLength(0);
    const kept = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('openai-chat', 'openai-still-allows', { temperature: 1.4 }),
    });
    expect(kept.statusCode).toBe(200);
    expect(JSON.parse(harness.openai.hits[0]?.body ?? '{}').temperature).toBe(1.4);
    expect(harness.anthropic.hits).toHaveLength(0);
  });

  it('maps provider 429, 500, and 529 without a second call or a leaked body', async () => {
    const secret = 'sk-ant-error-secret';
    const harness = await boot(db, {
      name: 'Error Tenant',
      openaiKey: 'sk-test-error-openai',
      anthropicKey: secret,
      anthropicHandle: (hit, _request, response) => {
        const text = (JSON.parse(hit.body) as { messages?: Array<{ content?: string }> }).messages?.[0]?.content;
        const status = text === 'rate' ? 429 : text === 'overload' ? 529 : 500;
        const type = text === 'rate' ? 'rate_limit_error' : text === 'overload' ? 'overloaded_error' : 'not_found_error';
        const responseHeaders: Record<string, string> = { 'content-type': 'application/json' };
        if (status === 500) responseHeaders['request-id'] = 'req_abc';
        response.writeHead(status, responseHeaders);
        response.end(JSON.stringify({
          type: 'error',
          error: { type, message: `leaked ${secret} and prompt ${text}` },
        }));
      },
    });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    const rate = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('claude-chat', 'rate'),
    });
    const server = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('claude-chat', 'server'),
    });
    const overload = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('claude-chat', 'overload'),
    });
    expect(rate.statusCode).toBe(429);
    expect(rate.json().error.code).toBe('rate_limit');
    expect(server.statusCode).toBe(502);
    expect(server.json().error.code).toBe('upstream_error');
    expect(overload.statusCode).toBe(529);
    expect(overload.json().error.code).toBe('overloaded');
    for (const response of [rate, server, overload]) {
      const text = JSON.stringify(response.json());
      expect(text).not.toContain(secret);
      expect(text).not.toContain('leaked');
    }
    expect(harness.anthropic.hits).toHaveLength(3);
    expect(harness.openai.hits).toHaveLength(0);
    expect(harness.ctx.lines.join('\n')).not.toContain(secret);
    const reasons = await harness.admin.query<{
      error_code: string;
      stop_reason: string | null;
      provider_request_id: string | null;
    }>(
      `SELECT error_code, stop_reason, provider_request_id FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [harness.tenant.tenantId],
    );
    expect(reasons.rows.map((row) => row.error_code)).toEqual(['rate_limit', 'upstream_error', 'overloaded']);
    expect(reasons.rows.map((row) => row.stop_reason)).toEqual(['rate_limit_error', 'not_found_error', 'overloaded_error']);
    expect(reasons.rows.map((row) => row.provider_request_id)).toEqual([null, 'req_abc', null]);
  });

  it('rejects an unexpected content block and does not fall back', async () => {
    const harness = await boot(db, {
      name: 'Block Tenant',
      openaiKey: 'sk-test-block-openai',
      anthropicKey: 'sk-ant-block',
      anthropicHandle: (hit, _request, response) => {
        const model = (JSON.parse(hit.body) as { model?: string }).model ?? 'claude-tenant';
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          ...anthropicMessage(model, 'hidden'),
          id: 'msg_tool',
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'prompt-block' } }],
        }));
      },
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('claude-chat', 'unique-block-prompt-zeta'),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('invalid_upstream_response');
    const publicBody = JSON.stringify(response.json());
    expect(publicBody).not.toContain('tool_use');
    expect(publicBody).not.toContain('lookup');
    expect(publicBody).not.toContain('msg_tool');
    expect(publicBody).not.toContain('unique-block-prompt-zeta');
    expect(publicBody).not.toContain('prompt-block');
    expect(harness.anthropic.hits).toHaveLength(1);
    expect(harness.openai.hits).toHaveLength(0);
    const attempt = await harness.admin.query<{
      provider_request_id: string | null;
      stop_reason: string | null;
      error_code: string | null;
      status: string;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      uncached_input_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
    }>(
      `SELECT provider_request_id, stop_reason, error_code, status, prompt_tokens, completion_tokens,
              total_tokens, uncached_input_tokens, cache_creation_input_tokens, cache_read_input_tokens
       FROM model_attempts WHERE tenant_id = $1`,
      [harness.tenant.tenantId],
    );
    expect(attempt.rows).toEqual([{
      provider_request_id: 'msg_tool',
      stop_reason: 'tool_use',
      error_code: 'invalid_upstream_response',
      status: 'failed',
      prompt_tokens: 13,
      completion_tokens: 4,
      total_tokens: 17,
      uncached_input_tokens: 10,
      cache_creation_input_tokens: 1,
      cache_read_input_tokens: 2,
    }]);
  });

  it('does not call Anthropic when the deployment or the connection is disabled', async () => {
    const harness = await boot(db, {
      name: 'Disabled Tenant',
      openaiKey: 'sk-test-disabled-openai',
      anthropicKey: 'sk-ant-disabled',
      anthropicEnabled: false,
      anthropicDeployment: 'disabled-claude',
    });
    const headers = authHeaders(harness.tenant.tenantId, harness.tenant.secret);
    const disabled = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('disabled-claude', 'disabled-prompt'),
    });
    expect(disabled.statusCode).toBe(404);
    expect(harness.anthropic.hits).toHaveLength(0);
    runCli(
      db,
      ['set-deployment-enabled', '--tenant-id', harness.tenant.tenantId, '--name', 'disabled-claude', '--enabled', 'true'],
      cliEnv(),
    );
    const enabled = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('disabled-claude', 'enabled-prompt'),
    });
    expect(enabled.statusCode).toBe(200);
    runCli(
      db,
      ['set-connection-enabled', '--tenant-id', harness.tenant.tenantId, '--provider', 'anthropic', '--enabled', 'false'],
      cliEnv(),
    );
    const connectionOff = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('disabled-claude', 'connection-off'),
    });
    const openaiStill = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers,
      payload: chatPayload('openai-chat', 'openai-remains'),
    });
    expect(connectionOff.statusCode).toBe(404);
    expect(openaiStill.statusCode).toBe(200);
    expect(harness.anthropic.hits).toHaveLength(1);
    expect(harness.openai.hits).toHaveLength(1);
  });

  it('times out one Anthropic call and cancels one Anthropic call', async () => {
    const timeout = await boot(db, {
      name: 'Timeout Tenant',
      openaiKey: 'sk-test-timeout-openai',
      anthropicKey: 'sk-ant-timeout',
      timeoutMs: 300,
      anthropicHandle: (_hit, _request, response) => {
        setTimeout(() => {
          if (response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(anthropicMessage('claude-tenant', 'late')));
        }, 3000);
      },
    });
    const timed = await timeout.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(timeout.tenant.tenantId, timeout.tenant.secret),
      payload: chatPayload('claude-chat', 'timeout-prompt'),
    });
    expect(timed.statusCode).toBe(504);
    expect(timed.json().error.code).toBe('timeout');
    expect(timeout.anthropic.hits).toHaveLength(1);
    expect(JSON.stringify(timed.json())).not.toContain('sk-ant-timeout');

    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = await boot(db, {
      name: 'Cancel Tenant',
      openaiKey: 'sk-test-cancel-openai',
      anthropicKey: 'sk-ant-cancel',
      timeoutMs: 10_000,
      anthropicHandle: () => {
        release?.();
      },
    });
    const port = await freePort();
    await cancel.ctx.app.listen({ host: '127.0.0.1', port });
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(cancel.tenant.tenantId, cancel.tenant.secret),
      body: chatPayload('claude-chat', 'cancel-prompt'),
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toThrow();
    const started = Date.now();
    let errorCode: string | null = null;
    while (Date.now() - started < 5000) {
      const stored = await cancel.admin.query<{ error_code: string | null }>(
        'SELECT error_code FROM model_attempts WHERE tenant_id = $1',
        [cancel.tenant.tenantId],
      );
      errorCode = stored.rows[0]?.error_code ?? null;
      if (errorCode === 'request_cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(cancel.anthropic.hits).toHaveLength(1);
    expect(errorCode).toBe('request_cancelled');
  });

  it('makes no upstream call when persistence fails and does not retry after a telemetry failure', async () => {
    const persist = await boot(db, {
      name: 'Db Fail Tenant',
      openaiKey: 'sk-test-db-openai',
      anthropicKey: 'sk-ant-db',
    });
    await persist.admin.query('REVOKE INSERT ON proxy_requests FROM llm_runtime');
    try {
      const response = await persist.ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(persist.tenant.tenantId, persist.tenant.secret),
        payload: chatPayload('claude-chat', 'db-fail-prompt'),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('service_unavailable');
      expect(persist.anthropic.hits).toHaveLength(0);
    } finally {
      await persist.admin.query('GRANT INSERT ON proxy_requests TO llm_runtime');
    }

    const telemetry = await boot(db, {
      name: 'Telemetry Tenant',
      openaiKey: 'sk-test-telemetry-openai',
      anthropicKey: 'sk-ant-telemetry',
    });
    await telemetry.admin.query('REVOKE UPDATE ON model_attempts FROM llm_runtime');
    try {
      const response = await telemetry.ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(telemetry.tenant.tenantId, telemetry.tenant.secret),
        payload: chatPayload('claude-chat', 'telemetry-fail-prompt'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().choices[0].message.content).toBe('claude-ok');
      expect(telemetry.anthropic.hits).toHaveLength(1);
      const logs = telemetry.ctx.lines.join('\n');
      expect(logs).toContain('attempt result was not recorded');
      expect(logs).toContain('"severity":"CRITICAL"');
      expect(logs).not.toContain('telemetry-fail-prompt');
      expect(logs).not.toContain('sk-ant-telemetry');
      const stored = await telemetry.admin.query<{ status: string }>(
        'SELECT status FROM proxy_requests WHERE tenant_id = $1',
        [telemetry.tenant.tenantId],
      );
      expect(stored.rows[0]?.status).toBe('pending');
    } finally {
      await telemetry.admin.query(
        `GRANT UPDATE (
           status, error_code, duration_ms, prompt_tokens, completion_tokens, total_tokens,
           provider_request_id, stop_reason, uncached_input_tokens, cache_creation_input_tokens,
           cache_read_input_tokens, stream_status, first_text_delta_ms, chunk_count, bytes_written,
           thoughts_tokens, serving_model, serving_provider,
           failure_class, dispatched, expense_certainty
         ) ON model_attempts TO llm_runtime`,
      );
    }
  });
});
