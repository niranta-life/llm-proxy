import OpenAI from 'openai';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, freePort, loadTestDatabase, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, enableStreaming, provisionTenant } from './inference-support.js';

const xaiLive = process.env.XAI_LIVE === '1';
const openRouterLive = process.env.OPENROUTER_LIVE === '1';

describe.skipIf(!xaiLive)('xAI live provider', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<unknown>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('runs one small non-streaming call and one small streaming call', async () => {
    const apiKey = process.env.XAI_API_KEY ?? '';
    const model = process.env.XAI_MODEL ?? 'grok-3';
    expect(apiKey.length).toBeGreaterThan(0);
    const tenant = provisionTenant(db, 'xAI Live');
    const env = cliEnv();
    runCli(db, ['register-xai-connection', '--tenant-id', tenant.tenantId, '--api-key', apiKey], env);
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'xai', '--name', 'grok-live', '--upstream-model', model, '--timeout-ms', '20000', '--capabilities', 'temperature,max_tokens', '--enabled', 'true'],
      env,
    );
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'grok-live' });
    const ctx = await createTestApp(db, { inferenceEnabled: true, credentialKey });
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    const admin = adminPool(db);
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
    });
    const client = new OpenAI({
      apiKey: tenant.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 20_000,
      defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
    });
    const response = await client.chat.completions.create({
      model: 'grok-live',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
    });
    expect(response.choices[0]?.message.content?.length).toBeGreaterThan(0);
    const stream = await client.chat.completions.create({
      model: 'grok-live',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
    expect(text.length).toBeGreaterThan(0);
    const stored = await admin.query<{ status: string; stream_status: string | null }>(
      `SELECT status, stream_status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
    expect(stored.rows[1]?.stream_status).toBe('completed');
  });
});

describe.skipIf(!openRouterLive)('OpenRouter live provider', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<unknown>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('runs one small non-streaming call and one small streaming call', async () => {
    const apiKey = process.env.OPENROUTER_API_KEY ?? '';
    const model = process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini';
    expect(apiKey.length).toBeGreaterThan(0);
    const tenant = provisionTenant(db, 'OpenRouter Live');
    const env = cliEnv();
    runCli(db, ['register-openrouter-connection', '--tenant-id', tenant.tenantId, '--api-key', apiKey], env);
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--provider',
        'openrouter',
        '--name',
        'router-live',
        '--upstream-model',
        model,
        '--timeout-ms',
        '20000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
        '--data-collection',
        'deny',
        '--allow-fallbacks',
        'false',
      ],
      env,
    );
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'router-live' });
    const ctx = await createTestApp(db, { inferenceEnabled: true, credentialKey });
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    const admin = adminPool(db);
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
    });
    const client = new OpenAI({
      apiKey: tenant.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 20_000,
      defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
    });
    const response = await client.chat.completions.create({
      model: 'router-live',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
    });
    expect(response.choices[0]?.message.content?.length).toBeGreaterThan(0);
    const stream = await client.chat.completions.create({
      model: 'router-live',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
      stream: true,
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
    expect(text.length).toBeGreaterThan(0);
    const stored = await admin.query<{ status: string; stream_status: string | null }>(
      `SELECT status, stream_status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
    expect(stored.rows[1]?.stream_status).toBe('completed');
  });
});
