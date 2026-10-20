import OpenAI from 'openai';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestApp, freePort, loadTestDatabase } from './helpers.js';
import { credentialKey, provisionTenant, registerAnthropic, registerInference } from './inference-support.js';
import { startMockAnthropic } from './mock-anthropic.js';
import { startMockUpstream } from './mock-openai.js';

describe('OpenAI SDK contract for both providers', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('calls OpenAI and Anthropic by changing only model', async () => {
    const openai = await startMockUpstream();
    const anthropic = await startMockAnthropic();
    const tenant = provisionTenant(db, 'Both Providers');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-contract-openai',
      deployment: 'openai-chat',
      upstreamModel: 'gpt-contract',
    });
    registerAnthropic(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-ant-contract',
      endpoint: anthropic.origin,
      deployment: 'claude-chat',
      upstreamModel: 'claude-contract',
      workspaceId: 'ws-contract',
      defaultMaxOutputTokens: 64,
    });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
    const port = await freePort();
    await ctx.app.listen({ host: '127.0.0.1', port });
    closers.push(async () => {
      await ctx.app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await openai.close();
      await anthropic.close();
    });

    const client = new OpenAI({
      apiKey: tenant.secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 10_000,
      defaultHeaders: { 'X-Tenant-ID': tenant.tenantId },
    });
    const messages = [{ role: 'user' as const, content: 'same-caller-prompt' }];
    const gpt = await client.chat.completions.create({ model: 'openai-chat', messages });
    const claude = await client.chat.completions.create({ model: 'claude-chat', messages });

    expect(gpt.object).toBe('chat.completion');
    expect(gpt.model).toBe('gpt-contract');
    expect(gpt.choices[0]?.message.content).toBe('ok');
    expect(claude.object).toBe('chat.completion');
    expect(claude.id).toBe('msg_test');
    expect(claude.model).toBe('claude-contract');
    expect(claude.choices[0]?.message.role).toBe('assistant');
    expect(claude.choices[0]?.message.content).toBe('claude-ok');
    expect(claude.choices[0]?.finish_reason).toBe('stop');
    expect(claude.usage).toMatchObject({ prompt_tokens: 13, completion_tokens: 4, total_tokens: 17 });

    expect(openai.hits).toHaveLength(1);
    expect(anthropic.hits).toHaveLength(1);
    expect(openai.hits[0]?.authorization).toBe('Bearer sk-test-contract-openai');
    expect(JSON.parse(openai.hits[0]?.body ?? '{}').model).toBe('gpt-contract');
    expect(anthropic.hits[0]?.url).toBe('/v1/messages');
    expect(anthropic.hits[0]?.apiKey).toBe('sk-ant-contract');
    expect(anthropic.hits[0]?.workspaceId).toBe('ws-contract');
    const sent = JSON.parse(anthropic.hits[0]?.body ?? '{}') as {
      model?: string;
      max_tokens?: number;
      messages?: unknown[];
    };
    expect(sent.model).toBe('claude-contract');
    expect(sent.max_tokens).toBe(64);
    expect(sent.messages).toEqual([{ role: 'user', content: 'same-caller-prompt' }]);
    expect(JSON.stringify(sent)).not.toContain('sk-test-contract-openai');

    const models = await client.models.list();
    const listed = [];
    for await (const model of models) listed.push(model);
    expect(listed.find((model) => model.id === 'openai-chat')?.owned_by).toBe('openai');
    expect(listed.find((model) => model.id === 'claude-chat')?.owned_by).toBe('anthropic');
    expect(listed.map((model) => model.id)).toContain('auto');
    expect(ctx.lines.join('\n')).not.toContain('sk-ant-contract');
    expect(ctx.lines.join('\n')).not.toContain('same-caller-prompt');
  });
});
