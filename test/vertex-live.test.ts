import OpenAI from 'openai';
import { afterAll, describe, expect, it } from 'vitest';
import { clearVertexClientCache } from '../src/inference/vertex-client.js';
import { createTestApp, freePort, loadTestDatabase, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, enableStreaming, provisionTenant } from './inference-support.js';

const live = process.env.VERTEX_LIVE === '1';
const projectId = process.env.VERTEX_PROJECT_ID ?? '';
const location = process.env.VERTEX_LOCATION ?? '';
const model = process.env.VERTEX_MODEL ?? 'gemini-2.5-flash';

describe.skipIf(!live)('vertex live provider', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<unknown>> = [];

  afterAll(async () => {
    clearVertexClientCache();
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('runs one small non-streaming call and one small streaming call', async () => {
    expect(projectId.length).toBeGreaterThan(0);
    expect(location.length).toBeGreaterThan(0);
    const tenant = provisionTenant(db, 'Vertex Live');
    const env = cliEnv();
    runCli(
      db,
      ['register-vertex-connection', '--tenant-id', tenant.tenantId, '--auth-mode', 'adc', '--project', projectId, '--location', location],
      env,
    );
    runCli(
      db,
      ['register-deployment', '--tenant-id', tenant.tenantId, '--provider', 'vertex', '--name', 'gemini-live', '--upstream-model', model, '--timeout-ms', '20000', '--capabilities', 'temperature,max_tokens', '--enabled', 'true'],
      env,
    );
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'gemini-live' });
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
      model: 'gemini-live',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
    });
    expect(response.choices[0]?.message.content?.length).toBeGreaterThan(0);
    expect(response.usage?.prompt_tokens).toBeGreaterThan(0);
    const stream = await client.chat.completions.create({
      model: 'gemini-live',
      temperature: 0,
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with ok.' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    let text = '';
    for await (const chunk of stream) text += chunk.choices[0]?.delta?.content ?? '';
    expect(text.length).toBeGreaterThan(0);
    const stored = await admin.query<{ prompt_tokens: number | null; stream_status: string | null }>(
      `SELECT prompt_tokens, stream_status FROM model_attempts WHERE tenant_id = $1 ORDER BY created_at`,
      [tenant.tenantId],
    );
    expect(stored.rows.length).toBe(2);
    expect(stored.rows[0]?.prompt_tokens).toBeGreaterThan(0);
    expect(stored.rows[1]?.stream_status).toBe('completed');
  });
});
