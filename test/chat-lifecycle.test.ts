import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from '../src/db/pools.js';
import {
  configFor,
  createTestApp,
  freePort,
  loadTestDatabase,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForReady,
} from './helpers.js';
import { adminPool, chatPayload, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

async function setup(
  db: ReturnType<typeof loadTestDatabase>,
  input: {
    name: string;
    apiKey: string;
    deployment: string;
    upstreamModel: string;
    timeoutMs?: number;
    enabled?: boolean;
    inferenceEnabled?: boolean;
    handle?: Parameters<typeof startMockUpstream>[0];
  },
) {
  const mock = await startMockUpstream(input.handle);
  const tenant = provisionTenant(db, input.name);
  registerInference(db, {
    tenantId: tenant.tenantId,
    apiKey: input.apiKey,
    deployment: input.deployment,
    upstreamModel: input.upstreamModel,
    timeoutMs: input.timeoutMs,
    enabled: input.enabled,
  });
  const ctx = await createTestApp(db, {
    inferenceEnabled: input.inferenceEnabled ?? true,
    upstreamBaseUrl: mock.baseUrl,
    credentialKey,
  });
  const admin = adminPool(db);
  closers.push(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await mock.close();
  });
  return { mock, tenant, ctx, admin };
}

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

describe('chat lifecycle', () => {
  const db = loadTestDatabase();

  it('records a successful request and attempt with reported usage', async () => {
    const prompt = 'unique-prompt-success-zeta';
    const harness = await setup(db, {
      name: 'Lifecycle Success',
      apiKey: 'sk-test-lifecycle-success',
      deployment: 'success-chat',
      upstreamModel: 'gpt-success',
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', prompt, { temperature: 0.1 }),
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('gpt-success');
    expect(body.choices[0].message.content).toBe('ok');
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(harness.mock.hits).toHaveLength(1);
    expect(harness.mock.hits[0]?.authorization).toBe('Bearer sk-test-lifecycle-success');
    expect(JSON.parse(harness.mock.hits[0]?.body ?? '{}').temperature).toBe(0.1);

    const rows = await harness.admin.query<{
      request_id: string;
      attempt_id: string;
      request_status: string;
      attempt_status: string;
      prompt_tokens: number | null;
      duration_ms: number | null;
      config_version: number;
    }>(
      `SELECT r.id AS request_id, a.id AS attempt_id, r.status AS request_status, a.status AS attempt_status,
              a.prompt_tokens, a.duration_ms, r.deployment_config_version AS config_version
       FROM proxy_requests r
       JOIN model_attempts a ON a.request_id = r.id
       WHERE r.tenant_id = $1`,
      [harness.tenant.tenantId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.request_id).not.toBe(rows.rows[0]?.attempt_id);
    expect(rows.rows[0]?.request_status).toBe('succeeded');
    expect(rows.rows[0]?.attempt_status).toBe('succeeded');
    expect(rows.rows[0]?.prompt_tokens).toBe(3);
    expect((rows.rows[0]?.duration_ms ?? -1) >= 0).toBe(true);
    expect(rows.rows[0]?.config_version).toBeGreaterThan(0);
    const leaked = await harness.admin.query<{ matches: number }>(
      `SELECT (
         (SELECT count(*) FROM proxy_requests WHERE requested_model LIKE $1) +
         (SELECT count(*) FROM model_attempts WHERE upstream_model LIKE $1 OR coalesce(error_code, '') LIKE $1) +
         (SELECT count(*) FROM provider_connections WHERE protected_credential LIKE $1)
       )::int AS matches`,
      [`%${prompt}%`],
    );
    expect(leaked.rows[0]?.matches).toBe(0);
    expect(harness.ctx.lines.join('\n')).not.toContain(prompt);
    expect(harness.ctx.lines.join('\n')).not.toContain('sk-test-lifecycle-success');
  });

  it('records a failed upstream response and does not retry', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Failure',
      apiKey: 'sk-test-lifecycle-failure',
      deployment: 'failure-chat',
      upstreamModel: 'gpt-failure',
      handle: (_hit, _request, response) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream blew up', type: 'server_error' } }));
      },
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('failure-chat', 'unique-prompt-failure-zeta'),
    });
    expect(response.statusCode).toBe(502);
    expect(response.json().error.code).toBe('upstream_error');
    expect(JSON.stringify(response.json())).not.toContain('upstream blew up');
    expect(harness.mock.hits).toHaveLength(1);
    const status = await harness.admin.query<{ status: string; error_code: string }>(
      `SELECT a.status, a.error_code
       FROM model_attempts a
       WHERE a.tenant_id = $1`,
      [harness.tenant.tenantId],
    );
    expect(status.rows[0]?.status).toBe('failed');
    expect(status.rows[0]?.error_code).toBe('upstream_error');
  });

  it('does not call upstream for an unsupported parameter', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Unsupported',
      apiKey: 'sk-test-lifecycle-unsupported',
      deployment: 'unsupported-chat',
      upstreamModel: 'gpt-unsupported',
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', 'hi', { tools: [{ type: 'function' }] }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('unsupported_parameter');
    expect(harness.mock.hits).toHaveLength(0);
  });

  it('stores missing usage as missing and reports it in metrics', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Missing Usage',
      apiKey: 'sk-test-lifecycle-missing',
      deployment: 'missing-chat',
      upstreamModel: 'gpt-missing',
      handle: (hit, _request, response) => {
        const parsed = JSON.parse(hit.body) as { model?: string };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completionBody(parsed.model ?? 'gpt-missing', 'no-usage', null)));
      },
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', 'unique-prompt-missing-zeta'),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().usage).toBeUndefined();
    const stored = await harness.admin.query<{ prompt_tokens: number | null; total_tokens: number | null }>(
      'SELECT prompt_tokens, total_tokens FROM model_attempts WHERE tenant_id = $1',
      [harness.tenant.tenantId],
    );
    expect(stored.rows[0]?.prompt_tokens).toBeNull();
    expect(stored.rows[0]?.total_tokens).toBeNull();
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const metrics = await harness.ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
    });
    expect(metrics.statusCode).toBe(200);
    const summary = metrics.json();
    expect(summary.requests).toEqual({ total: 1, succeeded: 1, failed: 0, pending: 0 });
    expect(summary.usage.promptTokens).toBeNull();
    expect(summary.usage.responsesMissingUsage).toBe(1);
    expect(summary.latency.samples).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('cost');
    expect(JSON.stringify(summary)).not.toContain('quality');
  });

  it('times out an upstream call after one request', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Timeout',
      apiKey: 'sk-test-lifecycle-timeout',
      deployment: 'timeout-chat',
      upstreamModel: 'gpt-timeout',
      timeoutMs: 300,
      handle: (_hit, _request, response) => {
        setTimeout(() => {
          if (response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completionBody('gpt-timeout', 'late')));
        }, 3000);
      },
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', 'unique-prompt-timeout-zeta'),
    });
    expect(response.statusCode).toBe(504);
    expect(response.json().error.code).toBe('timeout');
    expect(harness.mock.hits).toHaveLength(1);
    const stored = await harness.admin.query<{ error_code: string }>(
      'SELECT error_code FROM model_attempts WHERE tenant_id = $1',
      [harness.tenant.tenantId],
    );
    expect(stored.rows[0]?.error_code).toBe('timeout');
  });

  it('does not call upstream when initial persistence fails', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Persist',
      apiKey: 'sk-test-lifecycle-persist',
      deployment: 'persist-chat',
      upstreamModel: 'gpt-persist',
    });
    await harness.admin.query('REVOKE INSERT ON proxy_requests FROM llm_runtime');
    try {
      const response = await harness.ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
        payload: chatPayload('auto', 'unique-prompt-persist-zeta'),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('service_unavailable');
      expect(harness.mock.hits).toHaveLength(0);
    } finally {
      await harness.admin.query('GRANT INSERT ON proxy_requests TO llm_runtime');
    }
  });

  it('returns a successful completion when telemetry persistence fails', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Telemetry',
      apiKey: 'sk-test-lifecycle-telemetry',
      deployment: 'telemetry-chat',
      upstreamModel: 'gpt-telemetry',
    });
    await harness.admin.query('REVOKE UPDATE ON model_attempts FROM llm_runtime');
    try {
      const response = await harness.ctx.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
        payload: chatPayload('auto', 'unique-prompt-telemetry-zeta'),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().choices[0].message.content).toBe('ok');
      expect(harness.mock.hits).toHaveLength(1);
      const logs = harness.ctx.lines.join('\n');
      expect(logs).toContain('attempt result was not recorded');
      expect(logs).toContain('"severity":"critical"');
      expect(logs).not.toContain('unique-prompt-telemetry-zeta');
      expect(logs).not.toContain('sk-test-lifecycle-telemetry');
      const stored = await harness.admin.query<{ status: string }>(
        'SELECT status FROM proxy_requests WHERE tenant_id = $1',
        [harness.tenant.tenantId],
      );
      expect(stored.rows[0]?.status).toBe('pending');
    } finally {
      await harness.admin.query(
        `GRANT UPDATE (
           status, error_code, duration_ms, prompt_tokens, completion_tokens, total_tokens,
           provider_request_id, stop_reason, uncached_input_tokens, cache_creation_input_tokens,
           cache_read_input_tokens, stream_status, first_text_delta_ms, chunk_count, bytes_written,
           thoughts_tokens, serving_model, serving_provider
         ) ON model_attempts TO llm_runtime`,
      );
    }
  });

  it('cancels the single upstream call when the caller aborts', async () => {
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await setup(db, {
      name: 'Lifecycle Cancel',
      apiKey: 'sk-test-lifecycle-cancel',
      deployment: 'cancel-chat',
      upstreamModel: 'gpt-cancel',
      timeoutMs: 10_000,
      handle: (_hit, _request, _response) => {
        release?.();
      },
    });
    const port = await freePort();
    await harness.ctx.app.listen({ host: '127.0.0.1', port });
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      body: chatPayload('auto', 'unique-prompt-cancel-zeta'),
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toThrow();
    const started = Date.now();
    let errorCode: string | null = null;
    while (Date.now() - started < 5000) {
      const stored = await harness.admin.query<{ error_code: string | null }>(
        'SELECT error_code FROM model_attempts WHERE tenant_id = $1',
        [harness.tenant.tenantId],
      );
      errorCode = stored.rows[0]?.error_code ?? null;
      if (errorCode === 'request_cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(harness.mock.hits).toHaveLength(1);
    expect(errorCode).toBe('request_cancelled');
  });

  it('makes one upstream call for each concurrent accepted request', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle Concurrent',
      apiKey: 'sk-test-lifecycle-concurrent',
      deployment: 'concurrent-chat',
      upstreamModel: 'gpt-concurrent',
    });
    const responses = await Promise.all(
      [0, 1, 2, 3].map((index) =>
        harness.ctx.app.inject({
          method: 'POST',
          url: '/v1/chat/completions',
          headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
          payload: chatPayload('auto', `concurrent-prompt-${index}`),
        }),
      ),
    );
    expect(responses.every((response) => response.statusCode === 200)).toBe(true);
    expect(harness.mock.hits).toHaveLength(4);
    const bodies = harness.mock.hits.map((hit) => hit.body);
    for (const index of [0, 1, 2, 3]) {
      expect(bodies.filter((body) => body.includes(`concurrent-prompt-${index}`))).toHaveLength(1);
    }
  });

  it('does not call upstream when inference is disabled', async () => {
    const mock = await startMockUpstream();
    const port = await freePort();
    const child = spawnServer(
      serviceEnv(db, {
        PORT: String(port),
        INFERENCE_ENABLED: 'false',
        OPENAI_BASE_URL: mock.baseUrl,
      }),
    );
    closers.push(async () => {
      await stopChild(child.child);
      await mock.close();
    });
    await waitForReady(port);
    const tenant = provisionTenant(db, 'Lifecycle Disabled');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-lifecycle-disabled',
      deployment: 'disabled-chat',
      upstreamModel: 'gpt-disabled',
    });
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      body: chatPayload('auto', 'unique-prompt-disabled-zeta'),
    });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error.code).toBe('inference_disabled');
    expect(mock.hits).toHaveLength(0);
    const runtime = createPool(configFor(db), 'runtime', undefined, 1);
    closers.push(async () => {
      await runtime.end();
    });
  });

  it('does not call upstream when the tenant has no enabled deployment', async () => {
    const harness = await setup(db, {
      name: 'Lifecycle No Deployment',
      apiKey: 'sk-test-lifecycle-nodeploy',
      deployment: 'nodeploy-chat',
      upstreamModel: 'gpt-nodeploy',
      enabled: false,
    });
    const response = await harness.ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(harness.tenant.tenantId, harness.tenant.secret),
      payload: chatPayload('auto', 'unique-prompt-nodeploy-zeta'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('model_not_found');
    expect(harness.mock.hits).toHaveLength(0);
  });
});
