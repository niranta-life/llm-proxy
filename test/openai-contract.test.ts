import OpenAI from 'openai';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, freePort, loadTestDatabase } from './helpers.js';
import { credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';

describe('OpenAI SDK contract', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('returns a compatible success, a compatible error, and GET /v1/models', async () => {
    const mock = await startMockUpstream();
    const tenant = provisionTenant(db, 'Contract Tenant');
    const other = provisionTenant(db, 'Contract Other');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-contract-alpha',
      deployment: 'contract-chat',
      upstreamModel: 'gpt-contract',
    });
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-test-contract-beta',
      deployment: 'other-chat',
      upstreamModel: 'gpt-other',
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
    });
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await mock.close();
    });

    const client = new OpenAI({
      apiKey: tenant.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 10_000,
      defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
    });
    const completion = await client.chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'contract-prompt' }],
    });
    expect(completion.object).toBe('chat.completion');
    expect(completion.model).toBe('gpt-contract');
    expect(completion.choices[0]?.message.content).toBe('ok');
    expect(mock.hits).toHaveLength(1);

    await expect(
      client.chat.completions.create({
        model: 'auto',
        messages: [{ role: 'user', content: 'tools' }],
        tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }],
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(mock.hits).toHaveLength(1);

    const unsupported = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
      body: JSON.stringify({
        model: 'auto',
        messages: [{ role: 'user', content: 'stream' }],
        stream: true,
      }),
    });
    expect(unsupported.status).toBe(400);
    const errorBody = await unsupported.json();
    expect(errorBody.error.type).toBe('invalid_request_error');
    expect(errorBody.error.param).toBe('stream');
    expect(mock.hits).toHaveLength(1);

    const models = await client.models.list();
    const ids = [];
    for await (const model of models) ids.push(model.id);
    expect(ids).toContain('auto');
    expect(ids).toContain('contract-chat');
    expect(ids).not.toContain('other-chat');
  });
});
