import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import OpenAI, { APIError } from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cachedVertexClient, clearVertexClientCache, type VertexClientSpec, type VertexGenerateClient, type VertexGenerateRequest } from '../src/inference/vertex-client.js';
import { cliEntry, createTestApp, freePort, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
import { adminPool, cliEnv, credentialKey, enableStreaming, provisionTenant, registerAnthropic } from './inference-support.js';
import { startMockAnthropic } from './mock-anthropic.js';
import { startMockUpstream } from './mock-openai.js';

const ALPHA_EMAIL = 'alpha-bot@alpha-vertex-proj.iam.gserviceaccount.com';
const BETA_EMAIL = 'beta-bot@beta-vertex-proj.iam.gserviceaccount.com';
const ALPHA_KEY = JSON.stringify({ client_email: ALPHA_EMAIL, private_key: `alpha-${'k'.repeat(80)}` });
const GUARDED = ['GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_VERTEX_BASE_URL'] as const;

type Call = { spec: VertexClientSpec; request: VertexGenerateRequest; kind: 'chat' | 'stream' };

function textOf(request: VertexGenerateRequest): string {
  return request.contents.map((content) => content.parts.map((part) => part.text).join('')).join('\n');
}

function hangUntilAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  return new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

function completion(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    responseId: 'resp-alpha',
    modelVersion: 'gemini-alpha-served',
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2, totalTokenCount: 8 },
    ...extra,
  };
}

describe('vertex chat', () => {
  const db = loadTestDatabase();
  const calls: Call[] = [];
  let mints = 0;
  let app: Awaited<ReturnType<typeof createTestApp>>['app'];
  let port = 0;
  const closers: Array<() => Promise<unknown>> = [];
  const alpha = { tenantId: '', secret: '' };
  const beta = { tenantId: '', secret: '' };
  let admin: ReturnType<typeof adminPool>;

  function clientFor(secret: string, tenantId: string): OpenAI {
    return new OpenAI({
      apiKey: secret,
      baseURL: `http://127.0.0.1:${port}/v1`,
      maxRetries: 0,
      timeout: 10_000,
      defaultHeaders: { 'X-Tenant-ID': tenantId },
    });
  }

  function buildClient(spec: VertexClientSpec): VertexGenerateClient {
    return {
      async generateContent(request) {
        calls.push({ spec, request, kind: 'chat' });
        const text = textOf(request);
        if (text.includes('status-401')) throw { status: 401 };
        if (text.includes('status-403')) throw { status: 403 };
        if (text.includes('status-404')) throw { status: 404 };
        if (text.includes('status-400')) throw { status: 400 };
        if (text.includes('hang-chat')) {
          await new Promise((_resolve, reject) => {
            request.config.abortSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          });
        }
        if (text.includes('block-me')) return { promptFeedback: { blockReason: 'SAFETY' }, candidates: [] };
        if (text.includes('image-out')) {
          return { candidates: [{ finishReason: 'STOP', content: { parts: [{ inlineData: { data: 'aa' } }] } }] };
        }
        if (text.includes('think-me')) {
          return completion('visible', {
            responseId: 'resp-think',
            modelVersion: 'gemini-think',
            candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'hidden-thought' }, { text: 'visible' }] } }],
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 2,
              totalTokenCount: 20,
              cachedContentTokenCount: 3,
              thoughtsTokenCount: 8,
            },
          });
        }
        if (text.includes('no-total')) {
          return completion('x', {
            usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 1, thoughtsTokenCount: 5 },
          });
        }
        return completion(spec.projectId === 'beta-vertex-proj' ? 'beta-ok' : 'alpha-ok');
      },
      generateContentStream(request) {
        calls.push({ spec, request, kind: 'stream' });
        const text = textOf(request);
        if (text.includes('hang-connect')) return hangUntilAbort(request.config.abortSignal);
        if (text.includes('hang-idle')) {
          return (async function* idle() {
            yield { responseId: 'resp-idle', modelVersion: 'gemini-alpha-served', candidates: [{ content: { parts: [{ text: 'Hi' }] } }] };
            await hangUntilAbort(request.config.abortSignal);
          })();
        }
        if (text.includes('total-me')) {
          return (async function* total() {
            for (;;) {
              yield { responseId: 'resp-total', modelVersion: 'gemini-alpha-served', candidates: [{ content: { parts: [{ text: 'tick' }] } }] };
              await new Promise((resolve) => setTimeout(resolve, 30));
            }
          })();
        }
        if (text.includes('truncate-me')) {
          return (async function* cut() {
            yield { responseId: 'resp-cut', modelVersion: 'gemini-alpha-served', candidates: [{ content: { parts: [{ text: 'partial' }] } }] };
          })();
        }
        if (text.includes('burst-me')) {
          return (async function* burst() {
            const block = 'z'.repeat(256 * 1024);
            for (;;) {
              yield { candidates: [{ content: { parts: [{ text: block }] } }] };
              await new Promise((resolve) => setImmediate(resolve));
            }
          })();
        }
        return (async function* success() {
          yield { responseId: 'resp-stream', modelVersion: 'gemini-alpha-served', candidates: [{ content: { parts: [{ text: 'Hello' }] } }] };
          yield {
            candidates: [{ finishReason: 'STOP', content: { parts: [{ text: ' world' }] } }],
            usageMetadata: {
              promptTokenCount: 5,
              candidatesTokenCount: 2,
              totalTokenCount: 9,
              thoughtsTokenCount: 2,
              cachedContentTokenCount: 1,
            },
          };
        })();
      },
      async listModels() {},
    };
  }

  beforeAll(async () => {
    clearVertexClientCache();
    const openai = await startMockUpstream();
    const anthropic = await startMockAnthropic();
    const createdAlpha = provisionTenant(db, 'Vertex Alpha');
    const createdBeta = provisionTenant(db, 'Vertex Beta');
    alpha.tenantId = createdAlpha.tenantId;
    alpha.secret = createdAlpha.secret;
    beta.tenantId = createdBeta.tenantId;
    beta.secret = createdBeta.secret;
    const env = cliEnv();
    runCli(db, ['register-vertex-connection', '--tenant-id', alpha.tenantId, '--api-key', ALPHA_KEY, '--project', 'alpha-vertex-proj', '--location', 'us-central1', '--service-account', ALPHA_EMAIL], env);
    runCli(db, ['register-deployment', '--tenant-id', alpha.tenantId, '--provider', 'vertex', '--name', 'gemini-alpha', '--upstream-model', 'gemini-2.5-flash', '--timeout-ms', '2000', '--capabilities', 'temperature,max_tokens,stop', '--enabled', 'true'], env);
    runCli(db, ['set-alias', '--tenant-id', alpha.tenantId, '--alias', 'auto', '--deployment', 'gemini-alpha'], env);
    runCli(db, ['register-deployment', '--tenant-id', alpha.tenantId, '--provider', 'vertex', '--name', 'gemini-off', '--upstream-model', 'gemini-off', '--timeout-ms', '2000', '--capabilities', 'temperature', '--enabled', 'false'], env);
    runCli(db, ['register-openai-connection', '--tenant-id', alpha.tenantId, '--api-key', 'sk-test-vertex-openai'], env);
    runCli(db, ['register-deployment', '--tenant-id', alpha.tenantId, '--provider', 'openai', '--name', 'openai-chat', '--upstream-model', 'gpt-vertex', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true'], env);
    registerAnthropic(db, { tenantId: alpha.tenantId, apiKey: 'sk-ant-vertex', endpoint: anthropic.origin, deployment: 'claude-chat', upstreamModel: 'claude-vertex', alias: false });
    runCli(db, ['register-xai-connection', '--tenant-id', alpha.tenantId, '--api-key', 'xai-test-key-0123456789'], env);
    runCli(db, ['register-deployment', '--tenant-id', alpha.tenantId, '--provider', 'xai', '--name', 'xai-chat', '--upstream-model', 'grok-test', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'false'], env);
    runCli(db, ['register-vertex-connection', '--tenant-id', beta.tenantId, '--auth-mode', 'impersonation', '--project', 'beta-vertex-proj', '--location', 'europe-west4', '--service-account', BETA_EMAIL, '--api-version', 'v1'], env);
    runCli(db, ['register-deployment', '--tenant-id', beta.tenantId, '--provider', 'vertex', '--name', 'gemini-beta', '--upstream-model', 'gemini-2.5-pro', '--timeout-ms', '2000', '--capabilities', 'temperature,max_tokens,stop', '--enabled', 'true'], env);
    runCli(db, ['set-alias', '--tenant-id', beta.tenantId, '--alias', 'auto', '--deployment', 'gemini-beta'], env);
    enableStreaming(db, { tenantId: alpha.tenantId, deployment: 'gemini-alpha', connectTimeoutMs: 400, idleTimeoutMs: 400, totalTimeoutMs: 3000, backpressureTimeoutMs: 300 });
    enableStreaming(db, { tenantId: beta.tenantId, deployment: 'gemini-beta', connectTimeoutMs: 400, idleTimeoutMs: 400, totalTimeoutMs: 3000, backpressureTimeoutMs: 300 });
    const ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      vertexClientFactory: (spec) =>
        cachedVertexClient(spec, {
          now: () => Date.now(),
          mint: async (value) => {
            mints += 1;
            return { client: buildClient(value), expiresAtMs: Date.now() + 10 * 60_000 };
          },
        }),
    });
    app = ctx.app;
    port = await freePort();
    await app.listen({ host: '127.0.0.1', port });
    admin = adminPool(db);
    listenedPort = port;
    adminQuery = async (tenantId) => {
      const row = await latest(tenantId);
      return row === undefined ? undefined : { stream_status: String(row.stream_status) };
    };
    closers.push(async () => {
      clearVertexClientCache();
      await app.close();
      await ctx.authPool.end();
      await ctx.runtimePool.end();
      await admin.end();
      await openai.close();
      await anthropic.close();
    });
  }, 180_000);

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  async function latest(tenantId: string): Promise<Record<string, unknown> | undefined> {
    const result = await admin.query(
      `SELECT a.status, a.error_code, a.duration_ms, a.prompt_tokens, a.completion_tokens, a.total_tokens, a.thoughts_tokens,
              a.cache_read_input_tokens, a.uncached_input_tokens, a.provider_request_id, a.stop_reason, a.stream_status
       FROM model_attempts a
       JOIN proxy_requests r ON r.id = a.request_id AND r.tenant_id = a.tenant_id
       WHERE a.tenant_id = $1
       ORDER BY a.created_at DESC
       LIMIT 1`,
      [tenantId],
    );
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  it('converts a text chat for the tenant project and records usage', async () => {
    const previous = GUARDED.map((key) => process.env[key]);
    process.env.GOOGLE_CLOUD_PROJECT = 'decoy-project';
    process.env.GOOGLE_VERTEX_BASE_URL = 'https://decoy.invalid/';
    const before = calls.length;
    try {
      const response = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
        model: 'auto',
        temperature: 0.2,
        max_tokens: 16,
        stop: ['END'],
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi' },
          { role: 'user', content: 'Again' },
        ],
      });
      expect(response.choices[0]?.message.content).toBe('alpha-ok');
      expect(response.model).toBe('gemini-alpha-served');
      expect(response.usage).toEqual({ prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 });
      expect(JSON.stringify(response)).not.toContain('hidden');
    } finally {
      GUARDED.forEach((key, index) => {
        const value = previous[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
    expect(process.env.GOOGLE_CLOUD_PROJECT).toBeUndefined();
    const call = calls[before];
    expect(call?.spec.projectId).toBe('alpha-vertex-proj');
    expect(call?.spec.location).toBe('us-central1');
    expect(call?.spec.authMode).toBe('service_account');
    expect(call?.spec.credentialJson).toContain(ALPHA_EMAIL);
    expect(call?.spec.credentialJson).not.toContain(BETA_EMAIL);
    expect(call?.request.model).toBe('gemini-2.5-flash');
    expect(call?.request.config.systemInstruction).toBe('Be brief.');
    expect(call?.request.config.automaticContinuation).toBe(false);
    expect(call?.request.contents.map((item) => item.role)).toEqual(['user', 'model', 'user']);
    const row = await latest(alpha.tenantId);
    expect(row).toMatchObject({ status: 'succeeded', prompt_tokens: 6, completion_tokens: 2, total_tokens: 8, provider_request_id: 'resp-alpha' });
  });

  it('keeps two tenants on their own project, model, and identity', async () => {
    const before = calls.length;
    const [left, right] = await Promise.all([
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'alpha-concurrent' }] }),
      clientFor(beta.secret, beta.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'beta-concurrent' }] }),
    ]);
    expect(left.choices[0]?.message.content).toBe('alpha-ok');
    expect(right.choices[0]?.message.content).toBe('beta-ok');
    const pair = calls.slice(before);
    const alphaCall = pair.find((item) => item.spec.tenantId === alpha.tenantId);
    const betaCall = pair.find((item) => item.spec.tenantId === beta.tenantId);
    expect(alphaCall?.spec.projectId).toBe('alpha-vertex-proj');
    expect(alphaCall?.request.model).toBe('gemini-2.5-flash');
    expect(alphaCall?.spec.credentialJson).toContain(ALPHA_EMAIL);
    expect(betaCall?.spec.projectId).toBe('beta-vertex-proj');
    expect(betaCall?.spec.location).toBe('europe-west4');
    expect(betaCall?.spec.authMode).toBe('impersonation');
    expect(betaCall?.spec.serviceAccountIdentity).toBe(BETA_EMAIL);
    expect(betaCall?.spec.credentialJson).toBeNull();
    expect(betaCall?.request.model).toBe('gemini-2.5-pro');
  });

  it('serves OpenAI and Anthropic and refuses a disabled deployment', async () => {
    const before = calls.length;
    const openai = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'openai-chat',
      messages: [{ role: 'user', content: 'openai-still' }],
    });
    const anthropic = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'claude-chat',
      messages: [{ role: 'user', content: 'claude-still' }],
    });
    expect(openai.choices[0]?.message.content).toBeTruthy();
    expect(anthropic.choices[0]?.message.content).toBeTruthy();
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'gemini-off', messages: [{ role: 'user', content: 'off' }] }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'xai-chat', messages: [{ role: 'user', content: 'xai' }] }),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls.length).toBe(before);
  });

  it('keeps provider failures on that tenant and refreshes an expired credential', async () => {
    const beforeMints = mints;
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'status-401' }] }),
    ).rejects.toMatchObject({ status: 401, code: 'expired_credentials' });
    expect(mints).toBe(beforeMints);
    const refreshed = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'after-refresh' }],
    });
    expect(refreshed.choices[0]?.message.content).toBe('alpha-ok');
    expect(mints).toBe(beforeMints + 1);
    await expect(
      clientFor(beta.secret, beta.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'status-403' }] }),
    ).rejects.toMatchObject({ status: 403, code: 'permission_denied' });
    const alphaStill = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'alpha-after-beta-deny' }],
    });
    expect(alphaStill.choices[0]?.message.content).toBe('alpha-ok');
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'status-404' }] }),
    ).rejects.toMatchObject({ status: 404, code: 'model_not_available' });
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'status-400' }] }),
    ).rejects.toMatchObject({ status: 400, code: 'invalid_project' });
    const betaRow = await latest(beta.tenantId);
    expect(betaRow?.error_code).toBe('permission_denied');
  });

  it('rejects unsupported fields and records thinking tokens without showing them', async () => {
    const before = calls.length;
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
        model: 'auto',
        messages: [{ role: 'user', content: 'top' }],
        top_p: 0.2,
      } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming),
    ).rejects.toBeInstanceOf(APIError);
    expect(calls.length).toBe(before);
    const thought = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'think-me' }],
    });
    expect(thought.choices[0]?.message.content).toBe('visible');
    expect(JSON.stringify(thought)).not.toContain('hidden-thought');
    expect(thought.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 20 });
    const row = await latest(alpha.tenantId);
    expect(row).toMatchObject({
      thoughts_tokens: 8,
      cache_read_input_tokens: 3,
      uncached_input_tokens: 7,
      completion_tokens: 2,
      total_tokens: 20,
      provider_request_id: 'resp-think',
    });
    const omitted = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'no-total' }],
    });
    expect(omitted.usage?.total_tokens).toBeUndefined();
    expect((await latest(alpha.tenantId))?.total_tokens).toBeNull();
    const blocked = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'block-me' }],
    });
    expect(blocked.choices[0]?.message.content).toBe('');
    expect(blocked.choices[0]?.finish_reason).toBe('content_filter');
    await expect(
      clientFor(alpha.secret, alpha.tenantId).chat.completions.create({ model: 'auto', messages: [{ role: 'user', content: 'image-out' }] }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('streams text in order and records usage without a false done marker after failure', async () => {
    const stream = await clientFor(alpha.secret, alpha.tenantId).chat.completions.create({
      model: 'auto',
      messages: [{ role: 'user', content: 'stream-ok' }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = chunks.map((chunk) => chunk.choices[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hello world');
    expect(chunks.at(-1)?.usage).toMatchObject({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 9 });
    expect(JSON.stringify(chunks)).not.toContain('thoughts');
    const row = await latest(alpha.tenantId);
    expect(row).toMatchObject({
      status: 'succeeded',
      stream_status: 'completed',
      thoughts_tokens: 2,
      cache_read_input_tokens: 1,
      provider_request_id: 'resp-stream',
      total_tokens: 9,
    });

    const truncated = await postRaw(alpha, { model: 'auto', messages: [{ role: 'user', content: 'truncate-me' }], stream: true });
    expect(truncated.raw).toContain('partial');
    expect(truncated.raw).not.toContain('[DONE]');
    expect((await latest(alpha.tenantId))?.stream_status).toBe('stream_truncated');
  });

  it('cancels, times out, and applies backpressure without writing done', async () => {
    const controller = new AbortController();
    const pending = clientFor(alpha.secret, alpha.tenantId).chat.completions.create(
      { model: 'auto', messages: [{ role: 'user', content: 'hang-connect' }], stream: true },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 50);
    await expect(pending).rejects.toThrow();
    await waitFor(alpha.tenantId, 'client_aborted');
    expect((await latest(alpha.tenantId))?.stream_status).toBe('client_aborted');

    const timed = await postRaw(alpha, { model: 'auto', messages: [{ role: 'user', content: 'hang-connect' }], stream: true });
    expect(timed.status).toBe(504);
    expect(timed.raw).not.toContain('[DONE]');
    expect((await latest(alpha.tenantId))?.error_code).toBe('timeout');

    const idle = await postRaw(alpha, { model: 'auto', messages: [{ role: 'user', content: 'hang-idle' }], stream: true });
    expect(idle.raw).toContain('Hi');
    expect(idle.raw).not.toContain('[DONE]');
    expect((await latest(alpha.tenantId))?.stream_status).toBe('timed_out');

    const stalled = await postPaused(alpha, { model: 'auto', messages: [{ role: 'user', content: 'burst-me' }], stream: true });
    expect(stalled.raw).not.toContain('[DONE]');
    expect((await latest(alpha.tenantId))?.stream_status).toBe('slow_consumer');
  });

  it('stops a live stream on the total timer while chunks reset idle', async () => {
    enableStreaming(db, {
      tenantId: alpha.tenantId,
      deployment: 'gemini-alpha',
      connectTimeoutMs: 5000,
      idleTimeoutMs: 5000,
      totalTimeoutMs: 400,
      backpressureTimeoutMs: 3000,
    });
    try {
      const started = Date.now();
      const response = await postRaw(alpha, { model: 'auto', messages: [{ role: 'user', content: 'total-me' }], stream: true });
      const elapsed = Date.now() - started;
      expect(response.status).toBe(200);
      expect(response.raw.split('tick').length - 1).toBeGreaterThan(1);
      expect(response.raw).not.toContain('[DONE]');
      const row = await latest(alpha.tenantId);
      expect(row?.stream_status).toBe('timed_out');
      expect(row?.error_code).toBe('timeout');
      expect(Number(row?.duration_ms)).toBeLessThan(5000);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      enableStreaming(db, {
        tenantId: alpha.tenantId,
        deployment: 'gemini-alpha',
        connectTimeoutMs: 400,
        idleTimeoutMs: 400,
        totalTimeoutMs: 3000,
        backpressureTimeoutMs: 300,
      });
    }
  });

  it('registers secret-less auth and stops a probe before a network call', () => {
    const gamma = provisionTenant(db, 'Vertex Gamma');
    const env = cliEnv();
    const registered = runCli(db, ['register-vertex-connection', '--tenant-id', gamma.tenantId, '--auth-mode', 'adc', '--project', 'gamma-vertex-proj', '--location', 'global'], env) as { authMode?: string };
    expect(registered.authMode).toBe('adc');
    const missing = spawnSync(process.execPath, [cliEntry, 'validate-vertex-credential', '--tenant-id', provisionTenant(db, 'Vertex Empty').tenantId], {
      cwd: projectRoot,
      env: serviceEnv(db, env),
      encoding: 'utf8',
    });
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toContain('vertex connection was not found');
    const noDeployment = spawnSync(process.execPath, [cliEntry, 'test-vertex-inference', '--tenant-id', gamma.tenantId], {
      cwd: projectRoot,
      env: serviceEnv(db, env),
      encoding: 'utf8',
    });
    expect(noDeployment.status).not.toBe(0);
    expect(noDeployment.stderr).toContain('deployment is required');
    const rejected = spawnSync(process.execPath, [cliEntry, 'register-vertex-connection', '--tenant-id', gamma.tenantId, '--auth-mode', 'impersonation', '--project', 'gamma-vertex-proj', '--location', 'global'], {
      cwd: projectRoot,
      env: serviceEnv(db, env),
      encoding: 'utf8',
    });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('service account identity is required');
    const withKey = spawnSync(
      process.execPath,
      [cliEntry, 'register-vertex-connection', '--tenant-id', provisionTenant(db, 'Vertex Adc Key').tenantId, '--auth-mode', 'adc', '--api-key', 'not-a-vertex-key', '--project', 'adc-vertex-proj', '--location', 'global'],
      { cwd: projectRoot, env: serviceEnv(db, env), encoding: 'utf8' },
    );
    expect(withKey.status).not.toBe(0);
    expect(withKey.stderr).toContain('api key is not allowed');
  });
});

function postRaw(tenant: { tenantId: string; secret: string }, body: unknown): Promise<{ status: number; raw: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: currentPort(),
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

let listenedPort = 0;
function currentPort(): number {
  return listenedPort;
}

function postPaused(tenant: { tenantId: string; secret: string }, body: unknown): Promise<{ status: number; raw: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: currentPort(),
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-tenant-id': tenant.tenantId,
          authorization: `Bearer ${tenant.secret}`,
        },
      },
      (res) => {
        res.pause();
        void waitFor(tenant.tenantId, 'slow_consumer')
          .then(() => {
            const parts: Buffer[] = [];
            res.resume();
            res.on('data', (chunk) => parts.push(Buffer.from(chunk)));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(parts).toString('utf8') }));
          })
          .catch(reject);
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitFor(tenantId: string, status: string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 4_000) {
    const row = await adminQuery(tenantId);
    if (row?.stream_status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const row = await adminQuery(tenantId);
  throw new Error(`stream status ${status} was not stored; latest=${row?.stream_status ?? 'none'}`);
}

let adminQuery: (tenantId: string) => Promise<{ stream_status?: string } | undefined> = async () => undefined;

