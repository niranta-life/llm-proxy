import { spawnSync } from 'node:child_process';
import OpenAI from 'openai';
import { afterAll, describe, expect, it } from 'vitest';
import { cliEntry, createTestApp, freePort, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
import { adminPool, cliEnv, credentialKey, enableStreaming, provisionTenant } from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';

type Hit = { url: string; authorization: string; accept: string; body: string; metadata: string };

function readUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function headerValue(input: RequestInfo | URL, init: RequestInit | undefined, name: string): string {
  const headers = new Headers(init?.headers);
  const direct = headers.get(name);
  if (direct) return direct;
  if (input instanceof Request) return input.headers.get(name) ?? '';
  return '';
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
  if (typeof init?.body === 'string') return init.body;
  if (init?.body instanceof Uint8Array) return Buffer.from(init.body).toString('utf8');
  if (input instanceof Request) return input.clone().text();
  return '';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function completion(model: string, content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-compatible',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 40,
      prompt_tokens_details: { cached_tokens: 9 },
      completion_tokens_details: { reasoning_tokens: 3 },
    },
    ...extra,
  };
}

function sse(frames: unknown[], done = true): string {
  const body = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return done ? `${body}data: [DONE]\n\n` : body;
}

function chunk(model: string, choice: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'chatcmpl-compatible',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model,
    choices: [choice],
    ...extra,
  };
}

function successSse(model: string, content: string, provider?: string): string {
  const providerField = provider === undefined ? {} : { provider };
  return sse([
    chunk(model, { index: 0, delta: { role: 'assistant' }, finish_reason: null }, providerField),
    chunk(model, { index: 0, delta: { content }, finish_reason: null }, providerField),
    chunk(model, { index: 0, delta: {}, finish_reason: 'stop' }, providerField),
    chunk(model, { index: 0, delta: {} }, {
      ...providerField,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 },
    }),
  ]);
}

function hang(signal: AbortSignal | null | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('hang timeout')), 8_000);
    const fail = (): void => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    };
    if (signal?.aborted) {
      fail();
      return;
    }
    signal?.addEventListener('abort', fail, { once: true });
  });
}

function installFetch(handler: (hit: Hit, signal: AbortSignal | null) => Response | Promise<Response>): {
  hits: Hit[];
  fetch: typeof fetch;
} {
  const hits: Hit[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    const hit = {
      url: readUrl(input),
      authorization: headerValue(input, init, 'authorization'),
      accept: headerValue(input, init, 'accept'),
      metadata: headerValue(input, init, 'x-openrouter-metadata'),
      body: await readBody(input, init),
    };
    hits.push(hit);
    return handler(hit, signal);
  };
  return { hits, fetch: fetchImpl };
}

async function listen(
  db: TestDatabase,
  fetchImpl: typeof fetch,
): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const ctx = await createTestApp(db, {
    inferenceEnabled: true,
    upstreamBaseUrl: 'http://127.0.0.1:9/v1',
    credentialKey,
    compatibleFetch: fetchImpl,
  });
  const port = await freePort();
  await ctx.app.listen({ host: '127.0.0.1', port });
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
    },
  };
}

function clientFor(baseURL: string, secret: string, tenantId: string): OpenAI {
  return new OpenAI({
    apiKey: secret,
    baseURL,
    maxRetries: 0,
    timeout: 10_000,
    defaultHeaders: { 'X-Tenant-ID': tenantId },
  });
}

describe('xAI and OpenRouter chat', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];
  const env = cliEnv();

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('serves enabled xAI text and a stream on the approved host with that tenant key', async () => {
    const tenant = provisionTenant(db, 'xAI Alpha');
    const admin = adminPool(db);
    closers.push(() => admin.end());
    runCli(db, ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-alpha-key'], env);
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'xai', '--name', 'grok-off', '--upstream-model', 'grok-off', '--timeout-ms', '5000', '--capabilities', 'temperature'],
      env,
    );
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'xai', '--name', 'grok-a', '--upstream-model', 'grok-3', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'],
      env,
    );
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'grok-a' });
    const transport = installFetch((hit) => {
      const parsed = JSON.parse(hit.body) as { model?: string; stream?: boolean };
      if (parsed.stream) {
        return new Response(successSse('grok-3-actual', 'grok-ok', 'xai'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return jsonResponse(200, completion('grok-3-actual', 'grok-ok', { provider: 'xai' }));
    });
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const client = clientFor(app.baseURL, tenant.secret, tenant.tenantId);
    await expect(
      client.chat.completions.create({ model: 'grok-off', messages: [{ role: 'user', content: 'nope' }] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(transport.hits).toHaveLength(0);
    runCli(db, ['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'grok-off', '--enabled', 'false'], env);

    const completionResponse = await client.chat.completions.create({
      model: 'grok-a',
      temperature: 0.2,
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(completionResponse.model).toBe('grok-3-actual');
    expect(completionResponse.choices[0]?.message.content).toBe('grok-ok');
    expect(completionResponse.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 });
    expect((completionResponse as { provider?: string }).provider).toBe('xai');
    const sent = JSON.parse(transport.hits[0]?.body ?? '{}') as { model?: string; provider?: unknown; stream?: boolean };
    expect(transport.hits[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(transport.hits[0]?.authorization).toBe('Bearer xai-alpha-key');
    expect(transport.hits[0]?.metadata).toBe('');
    expect(sent.model).toBe('grok-3');
    expect(sent.provider).toBeUndefined();
    expect(sent.stream).toBe(false);

    const raw = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({
        model: 'grok-a',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'stream' }],
      }),
    });
    expect(raw.status).toBe(200);
    const text = await raw.text();
    expect(text).toContain('grok-ok');
    expect(text).toContain('grok-3-actual');
    expect(text).toContain('"prompt_tokens":11');
    expect(text).toContain('"total_tokens":40');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(transport.hits[1]?.url).toBe('https://api.x.ai/v1/chat/completions');
    expect(transport.hits[1]?.authorization).toBe('Bearer xai-alpha-key');
    expect(transport.hits[1]?.metadata).toBe('');
    const streamBody = JSON.parse(transport.hits[1]?.body ?? '{}') as { model?: string; stream?: boolean; provider?: unknown };
    expect(streamBody.model).toBe('grok-3');
    expect(streamBody.stream).toBe(true);
    expect(streamBody.provider).toBeUndefined();

    const stored = await admin.query<{
      status: string;
      upstream_model: string;
      serving_model: string | null;
      serving_provider: string | null;
      prompt_tokens: number | null;
      completion_tokens: number | null;
      total_tokens: number | null;
      stream_status: string | null;
    }>(
      `SELECT status, upstream_model, serving_model, serving_provider, prompt_tokens, completion_tokens, total_tokens, stream_status
       FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows).toMatchObject([
      {
        status: 'succeeded',
        upstream_model: 'grok-3',
        serving_model: 'grok-3-actual',
        serving_provider: 'xai',
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 40,
        stream_status: null,
      },
      {
        status: 'succeeded',
        upstream_model: 'grok-3',
        serving_model: 'grok-3-actual',
        serving_provider: 'xai',
        prompt_tokens: 11,
        completion_tokens: 7,
        total_tokens: 40,
        stream_status: 'completed',
      },
    ]);
  });

  it('rejects an unsupported xAI field before the upstream call and does not retry', async () => {
    const tenant = provisionTenant(db, 'xAI Errors');
    runCli(db, ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-error-key'], env);
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'xai', '--name', 'grok-e', '--upstream-model', 'grok-3', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'],
      env,
    );
    const transport = installFetch(() => jsonResponse(500, { error: { message: 'upstream-secret-text' } }));
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const unsupported = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({
        model: 'grok-e',
        messages: [{ role: 'user', content: 'tools' }],
        tools: [{ type: 'function', function: { name: 'lookup' } }],
        base_url: 'https://evil.example/v1',
      }),
    });
    expect(unsupported.status).toBe(400);
    expect(transport.hits).toHaveLength(0);
    const failed = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({ model: 'grok-e', messages: [{ role: 'user', content: 'boom' }] }),
    });
    expect(failed.status).toBe(502);
    const body = await failed.text();
    expect(body).not.toContain('upstream-secret-text');
    expect(transport.hits).toHaveLength(1);
    expect(transport.hits[0]?.authorization).toBe('Bearer xai-error-key');
    expect(transport.hits[0]?.url).toBe('https://api.x.ai/v1/chat/completions');
  });

  it('cancels an xAI call and keeps a stream failure from writing DONE', async () => {
    const tenant = provisionTenant(db, 'xAI Cancel');
    const admin = adminPool(db);
    closers.push(() => admin.end());
    runCli(db, ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'xai-cancel-key'], env);
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'xai', '--name', 'grok-c', '--upstream-model', 'grok-3', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'],
      env,
    );
    enableStreaming(db, {
      tenantId: tenant.tenantId,
      deployment: 'grok-c',
      connectTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      totalTimeoutMs: 400,
      backpressureTimeoutMs: 3000,
    });
    let mode: 'hang' | 'break' | 'timeout' = 'hang';
    const transport = installFetch((hit, signal) => {
      if (mode === 'hang' || mode === 'timeout') return hang(signal);
      return new Response(
        sse(
          [chunk('grok-3-actual', { index: 0, delta: { content: 'partial' }, finish_reason: null })],
          false,
        ) + 'data: {"error":{"message":"upstream-secret-text"}}\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const controller = new AbortController();
    const started = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (transport.hits.length > 0) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    const pending = fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({ model: 'grok-c', messages: [{ role: 'user', content: 'wait' }] }),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    mode = 'break';
    const broken = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({ model: 'grok-c', stream: true, messages: [{ role: 'user', content: 'break' }] }),
    });
    expect(broken.status).toBe(200);
    const brokenText = await broken.text();
    expect(brokenText).toContain('partial');
    expect(brokenText).not.toContain('[DONE]');
    expect(brokenText).not.toContain('upstream-secret-text');
    mode = 'timeout';
    const timed = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({ model: 'grok-c', stream: true, messages: [{ role: 'user', content: 'timeout' }] }),
    });
    expect(timed.status).toBe(504);
    expect(await timed.text()).not.toContain('[DONE]');
    const stored = await admin.query<{ status: string; error_code: string | null; stream_status: string | null }>(
      `SELECT status, error_code, stream_status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows[0]).toMatchObject({ status: 'failed', error_code: 'request_cancelled' });
    expect(stored.rows[1]).toMatchObject({ status: 'failed', stream_status: 'provider_failed' });
    expect(stored.rows[2]).toMatchObject({ status: 'failed', error_code: 'timeout', stream_status: 'timed_out' });
  });

  it('sends stored OpenRouter restrictions and fails closed without a serving provider', async () => {
    const tenant = provisionTenant(db, 'Router Policy');
    const admin = adminPool(db);
    closers.push(() => admin.end());
    const rejected = spawnSync(process.execPath, [
      cliEntry,
      'register-deployment',
      '--tenant-id',
      tenant.tenantId,
      '--provider',
      'xai',
      '--name',
      'not-router',
      '--upstream-model',
      'grok-3',
      '--timeout-ms',
      '5000',
      '--capabilities',
      'temperature',
      '--downstream-providers',
      'anthropic',
    ], { cwd: projectRoot, env: serviceEnv(db, env), encoding: 'utf8' });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('deployment arguments are invalid');
    runCli(db, ['register-openrouter-connection', '--tenant-id', tenant.tenantId, '--api-key', 'router-policy-key'], env);
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'openrouter',
        '--name',
        'router-off',
        '--upstream-model',
        'openai/gpt-4o-mini',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--downstream-providers',
        'anthropic',
        '--data-collection',
        'deny',
        '--allow-fallbacks',
        'false',
        '--require-serving-provider',
        'true',
      ],
      env,
    );
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'openrouter',
        '--name',
        'router-a',
        '--upstream-model',
        'openai/gpt-4o-mini',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
        '--downstream-providers',
        'anthropic',
        '--data-collection',
        'deny',
        '--allow-fallbacks',
        'false',
        '--require-serving-provider',
        'true',
      ],
      env,
    );
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'router-a' });
    let variant: 'missing' | 'wrong' | 'ok' | 'late' = 'missing';
    const transport = installFetch((hit) => {
      const parsed = JSON.parse(hit.body) as { stream?: boolean };
      if (variant === 'missing' && parsed.stream) {
        return new Response(successSse('anthropic/claude-3.5', 'hidden'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      if (variant === 'missing') return jsonResponse(200, completion('anthropic/claude-3.5', 'hidden'));
      if (variant === 'wrong') return jsonResponse(200, completion('anthropic/claude-3.5', 'hidden', { provider: 'google' }));
      if (variant === 'late') {
        return new Response(
          sse([
            chunk('anthropic/claude-3.5-actual', { index: 0, delta: { role: 'assistant' }, finish_reason: null }),
            chunk('anthropic/claude-3.5-actual', { index: 0, delta: { content: 'held-text' }, finish_reason: null }),
            chunk('anthropic/claude-3.5-actual', { index: 0, delta: {}, finish_reason: 'stop' }),
            chunk('anthropic/claude-3.5-actual', { index: 0, delta: {} }, {
              choices: [],
              provider: 'anthropic',
              usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 },
            }),
          ]),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        );
      }
      if (parsed.stream) {
        return new Response(successSse('anthropic/claude-3.5-actual', 'router-ok', 'anthropic'), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }
      return jsonResponse(200, completion('anthropic/claude-3.5-actual', 'router-ok', { provider: 'anthropic' }));
    });
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const headers = {
      'content-type': 'application/json',
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
    };
    const disabled = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'router-off', messages: [{ role: 'user', content: 'off' }] }),
    });
    expect(disabled.status).toBe(404);
    expect(transport.hits).toHaveLength(0);
    const callerRoute = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'router-a',
        messages: [{ role: 'user', content: 'route' }],
        provider: { only: ['google'] },
        base_url: 'https://evil.example/v1',
      }),
    });
    expect(callerRoute.status).toBe(400);
    expect(transport.hits).toHaveLength(0);
    const missing = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'router-a', messages: [{ role: 'user', content: 'missing' }] }),
    });
    expect(missing.status).toBe(502);
    const missingBody = await missing.json();
    expect(missingBody.error.code).toBe('serving_provider_unverified');
    expect(JSON.stringify(missingBody)).not.toContain('hidden');
    const sent = JSON.parse(transport.hits[0]?.body ?? '{}') as {
      model?: string;
      provider?: { only?: string[]; data_collection?: string; allow_fallbacks?: boolean; order?: string[] };
      models?: unknown;
      route?: unknown;
    };
    expect(transport.hits[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(transport.hits[0]?.authorization).toBe('Bearer router-policy-key');
    expect(transport.hits.every((hit) => hit.metadata === 'enabled')).toBe(true);
    expect(sent.model).toBe('openai/gpt-4o-mini');
    expect(sent.provider).toEqual({ only: ['anthropic'], data_collection: 'deny', allow_fallbacks: false });
    expect(sent.provider?.order).toBeUndefined();
    expect(sent.models).toBeUndefined();
    expect(sent.route).toBeUndefined();
    variant = 'wrong';
    const wrong = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'router-a', messages: [{ role: 'user', content: 'wrong' }] }),
    });
    expect(wrong.status).toBe(502);
    expect((await wrong.json()).error.code).toBe('serving_provider_unverified');
    variant = 'ok';
    const ok = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'router-a', temperature: 0.2, messages: [{ role: 'user', content: 'ok' }] }),
    });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.model).toBe('anthropic/claude-3.5-actual');
    expect(okBody.provider).toBe('anthropic');
    expect(okBody.choices[0].message.content).toBe('router-ok');
    expect(okBody.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 });
    variant = 'late';
    const late = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'router-a',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'late' }],
      }),
    });
    expect(late.status).toBe(200);
    const lateText = await late.text();
    expect(lateText).toContain('held-text');
    expect(lateText).toContain('anthropic/claude-3.5-actual');
    expect(lateText.endsWith('data: [DONE]\n\n')).toBe(true);
    variant = 'missing';
    const missingStream = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'router-a', stream: true, messages: [{ role: 'user', content: 'no-id' }] }),
    });
    expect(missingStream.status).toBe(502);
    const missingStreamText = await missingStream.text();
    expect(missingStreamText).not.toContain('[DONE]');
    expect(missingStreamText).not.toContain('hidden');
    const stored = await admin.query<{ status: string; serving_provider: string | null; serving_model: string | null; error_code: string | null }>(
      `SELECT status, serving_provider, serving_model, error_code
       FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows[0]).toMatchObject({ status: 'failed', error_code: 'serving_provider_unverified', serving_provider: null });
    expect(stored.rows[1]).toMatchObject({ status: 'failed', error_code: 'serving_provider_unverified' });
    expect(stored.rows[2]).toMatchObject({
      status: 'succeeded',
      serving_provider: 'anthropic',
      serving_model: 'anthropic/claude-3.5-actual',
    });
    expect(stored.rows[3]).toMatchObject({
      status: 'succeeded',
      serving_provider: 'anthropic',
      serving_model: 'anthropic/claude-3.5-actual',
    });
    expect(stored.rows[4]).toMatchObject({ status: 'failed', error_code: 'serving_provider_unverified' });
    expect(transport.hits.every((hit) => hit.metadata === 'enabled')).toBe(true);
  });

  it('keeps two OpenRouter tenants on their own key, model, and routing rule', async () => {
    const alpha = provisionTenant(db, 'Router Alpha');
    const beta = provisionTenant(db, 'Router Beta');
    runCli(db, ['register-openrouter-connection', '--tenant-id', alpha.tenantId, '--api-key', 'router-alpha-key'], env);
    runCli(db, ['register-openrouter-connection', '--tenant-id', beta.tenantId, '--api-key', 'router-beta-key'], env);
    runCli(
      db,
      ['register-deployment', '--tenant-id', alpha.tenantId, '--provider', 'openrouter', '--name', 'alpha-route', '--upstream-model', 'alpha/model', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true', '--downstream-providers', 'anthropic', '--data-collection', 'deny', '--allow-fallbacks', 'false'],
      env,
    );
    runCli(
      db,
      ['register-deployment', '--tenant-id', beta.tenantId, '--provider', 'openrouter', '--name', 'beta-route', '--upstream-model', 'beta/model', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true', '--downstream-providers', 'google', '--data-collection', 'allow', '--allow-fallbacks', 'true'],
      env,
    );
    const transport = installFetch((hit) => {
      const parsed = JSON.parse(hit.body) as { model?: string };
      const provider = hit.authorization.endsWith('alpha-key') ? 'anthropic' : 'google';
      return jsonResponse(200, completion(`${parsed.model ?? 'model'}-actual`, 'tenant-ok', { provider }));
    });
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const alphaClient = clientFor(app.baseURL, alpha.secret, alpha.tenantId);
    const betaClient = clientFor(app.baseURL, beta.secret, beta.tenantId);
    const [alphaResponse, betaResponse] = await Promise.all([
      alphaClient.chat.completions.create({ model: 'alpha-route', messages: [{ role: 'user', content: 'alpha' }] }),
      betaClient.chat.completions.create({ model: 'beta-route', messages: [{ role: 'user', content: 'beta' }] }),
    ]);
    expect(alphaResponse.choices[0]?.message.content).toBe('tenant-ok');
    expect(betaResponse.choices[0]?.message.content).toBe('tenant-ok');
    expect(alphaResponse.model).toBe('alpha/model-actual');
    expect(betaResponse.model).toBe('beta/model-actual');
    const bodies = transport.hits.map((hit) => ({
      authorization: hit.authorization,
      body: JSON.parse(hit.body) as { model?: string; provider?: { only?: string[]; data_collection?: string; allow_fallbacks?: boolean } },
    }));
    const alphaHit = bodies.find((hit) => hit.authorization === 'Bearer router-alpha-key');
    const betaHit = bodies.find((hit) => hit.authorization === 'Bearer router-beta-key');
    expect(alphaHit?.body).toMatchObject({
      model: 'alpha/model',
      provider: { only: ['anthropic'], data_collection: 'deny', allow_fallbacks: false },
    });
    expect(betaHit?.body).toMatchObject({
      model: 'beta/model',
      provider: { only: ['google'], data_collection: 'allow', allow_fallbacks: true },
    });
    expect(transport.hits.every((hit) => hit.url === 'https://openrouter.ai/api/v1/chat/completions')).toBe(true);
    expect(transport.hits.every((hit) => hit.metadata === 'enabled')).toBe(true);
  });

  it('accepts a long OpenRouter stream when the final chunk names the selected provider', async () => {
    const tenant = provisionTenant(db, 'Router Identity');
    const admin = adminPool(db);
    closers.push(() => admin.end());
    runCli(db, ['register-openrouter-connection', '--tenant-id', tenant.tenantId, '--api-key', 'router-identity-key'], env);
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'openrouter',
        '--name',
        'router-id',
        '--upstream-model',
        'openai/gpt-4o-mini',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'true',
        '--downstream-providers',
        'openai',
        '--data-collection',
        'deny',
        '--allow-fallbacks',
        'false',
        '--require-serving-provider',
        'true',
      ],
      env,
    );
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'router-id' });
    const metadata = {
      openrouter_metadata: {
        summary: 'selected=Anthropic',
        endpoints: {
          available: [
            { provider: 'Anthropic', model: 'anthropic/claude-3.5', selected: false },
            { provider: 'OpenAI', model: 'openai/gpt-4o-mini', selected: true },
          ],
        },
      },
    };
    const textDeltas = 300;
    let mode: 'chat' | 'stream' = 'chat';
    const transport = installFetch(() => {
      if (mode === 'stream') {
        const frames = Array.from({ length: textDeltas }, () =>
          chunk('openai/gpt-4o-mini-actual', { index: 0, delta: { content: 'Q' }, finish_reason: null }),
        );
        frames.push(
          chunk('openai/gpt-4o-mini-actual', { index: 0, delta: {}, finish_reason: 'stop' }, {
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 },
            ...metadata,
          }),
        );
        return new Response(sse(frames), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return jsonResponse(200, completion('openai/gpt-4o-mini-actual', 'router-meta', metadata));
    });
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const headers = {
      'content-type': 'application/json',
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
    };
    const chat = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'router-id', messages: [{ role: 'user', content: 'meta' }] }),
    });
    expect(chat.status).toBe(200);
    const chatBody = await chat.json();
    expect(chatBody.model).toBe('openai/gpt-4o-mini-actual');
    expect(chatBody.provider).toBe('OpenAI');
    expect(chatBody.choices[0].message.content).toBe('router-meta');
    expect(chatBody.usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 40 });
    expect(transport.hits[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(transport.hits[0]?.authorization).toBe('Bearer router-identity-key');
    expect(transport.hits[0]?.metadata).toBe('enabled');
    const sent = JSON.parse(transport.hits[0]?.body ?? '{}') as { provider?: { only?: string[] } };
    expect(sent.provider).toEqual({ only: ['openai'], data_collection: 'deny', allow_fallbacks: false });
    mode = 'stream';
    const streamed = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: 'router-id',
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'long' }],
      }),
    });
    expect(streamed.status).toBe(200);
    const text = await streamed.text();
    expect(text.match(/"content":"Q"/g)).toHaveLength(textDeltas);
    expect(text).toContain('openai/gpt-4o-mini-actual');
    expect(text.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(text).not.toContain('Anthropic');
    expect(transport.hits[1]?.metadata).toBe('enabled');
    expect(transport.hits).toHaveLength(2);
    const stored = await admin.query<{ status: string; serving_provider: string | null; serving_model: string | null }>(
      `SELECT status, serving_provider, serving_model FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows).toMatchObject([
      { status: 'succeeded', serving_provider: 'OpenAI', serving_model: 'openai/gpt-4o-mini-actual' },
      { status: 'succeeded', serving_provider: 'OpenAI', serving_model: 'openai/gpt-4o-mini-actual' },
    ]);
  });

  it('does not serve DGX and still serves OpenAI through its own base URL', async () => {
    const tenant = provisionTenant(db, 'DGX Still');
    runCli(
      db,
      ['register-dgx-connection', '--tenant-id', tenant.tenantId, '--api-key', 'dgx-test-key', '--endpoint', 'https://dgx.lab.internal:8443/v1'],
      env,
    );
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'dgx', '--name', 'dgx-chat', '--upstream-model', 'dgx-model', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'],
      env,
    );
    const transport = installFetch(() => jsonResponse(200, completion('should-not-run', 'no')));
    const app = await listen(db, transport.fetch);
    closers.push(app.close);
    const headers = {
      'content-type': 'application/json',
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
    };
    const chat = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'dgx-chat', messages: [{ role: 'user', content: 'dgx' }] }),
    });
    expect(chat.status).toBe(503);
    const streamed = await fetch(`${app.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'dgx-chat', stream: true, messages: [{ role: 'user', content: 'dgx' }] }),
    });
    expect(streamed.status).toBe(400);
    expect(await streamed.text()).not.toContain('[DONE]');
    expect(transport.hits).toHaveLength(0);

    const mock = await startMockUpstream();
    closers.push(mock.close);
    runCli(db, ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-openai-still'], env);
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'openai', '--name', 'openai-still', '--upstream-model', 'gpt-still', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'],
      env,
    );
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      compatibleFetch: transport.fetch,
    });
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
    });
    const client = clientFor(`http://127.0.0.1:${port}/v1`, tenant.secret, tenant.tenantId);
    const openai = await client.chat.completions.create({
      model: 'openai-still',
      messages: [{ role: 'user', content: 'openai' }],
    });
    expect(openai.choices[0]?.message.content).toBe('ok');
    expect(mock.hits[0]?.url).toContain('/chat/completions');
    expect(mock.hits[0]?.authorization).toBe('Bearer sk-openai-still');
    expect(transport.hits).toHaveLength(0);
  });
});
