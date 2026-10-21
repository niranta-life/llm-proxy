import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadTestDatabase } from './helpers.js';
import { chatPayload, provisionTenant } from './inference-support.js';
import {
  UPSTREAM,
  chat,
  cliJson,
  defaultNames,
  doneCount,
  grewOnly,
  latestAttempt,
  listenProxy,
  openDb,
  openPost,
  registerSix,
  sceneContent,
  snapshot,
  startDoubles,
  vertexKey,
  waitFor,
  type Doubles,
  type ProviderName,
  type SixKeys,
} from './hardening-support.js';

const PROVIDERS = Object.keys(UPSTREAM) as ProviderName[];
const RATE: Record<ProviderName, { status: number; code: string }> = {
  openai: { status: 429, code: 'rate_limit' },
  anthropic: { status: 429, code: 'rate_limit' },
  vertex: { status: 502, code: 'upstream_error' },
  xai: { status: 429, code: 'rate_limit' },
  openrouter: { status: 429, code: 'rate_limit' },
  dgx: { status: 429, code: 'rate_limit' },
};
const TOKENS: Record<ProviderName, { prompt: number; completion: number; total: number; content: string }> = {
  openai: { prompt: 3, completion: 2, total: 5, content: 'openai-ok' },
  anthropic: { prompt: 13, completion: 4, total: 17, content: 'claude-ok' },
  vertex: { prompt: 6, completion: 2, total: 8, content: 'vertex-ok' },
  xai: { prompt: 4, completion: 3, total: 7, content: 'xai-ok' },
  openrouter: { prompt: 8, completion: 1, total: 9, content: 'router-ok' },
  dgx: { prompt: 11, completion: 7, total: 40, content: 'private-ok' },
};

describe('provider compatibility matrix', () => {
  const db = loadTestDatabase();
  const names = defaultNames('matrix');
  const email = 'matrix-bot@matrix-vertex-proj.iam.gserviceaccount.com';
  const keys: SixKeys = {
    openai: 'sk-matrix-openai-alpha',
    anthropic: 'sk-ant-matrix-alpha',
    vertexEmail: email,
    vertexKey: vertexKey(email),
    vertexProject: 'matrix-vertex-proj',
    xai: 'xai-matrix-key-alpha1',
    openrouter: 'or-matrix-key-alpha1',
    dgx: 'dgx-matrix-key-alpha1',
  };
  const tenant = { tenantId: '', secret: '' };
  let doubles: Doubles;
  let port = 0;
  let closeApp: () => Promise<void> = async () => undefined;
  let admin: ReturnType<typeof openDb>;
  const proof: unknown[] = [];

  beforeAll(async () => {
    doubles = await startDoubles();
    const created = provisionTenant(db, 'Matrix Tenant');
    tenant.tenantId = created.tenantId;
    tenant.secret = created.secret;
    registerSix(db, tenant.tenantId, names, keys, doubles.anthropicOrigin);
    cliJson(db, [
      'register-deployment',
      '--tenant-id',
      tenant.tenantId,
      '--provider',
      'openai',
      '--name',
      'openai-off',
      '--upstream-model',
      'gpt-off',
      '--timeout-ms',
      '1200',
      '--capabilities',
      'temperature',
      '--enabled',
      'false',
    ]);
    const listened = await listenProxy(db, doubles);
    port = listened.port;
    closeApp = listened.close;
    admin = openDb(db);
  }, 180_000);

  afterAll(async () => {
    console.log(JSON.stringify({ providerMatrix: proof }));
    await closeApp();
    await admin.end();
    await doubles.close();
  });

  function expectSelected(provider: ProviderName): void {
    if (provider === 'openai') {
      const hit = doubles.openaiHits.at(-1);
      expect(hit?.authorization).toBe(`Bearer ${keys.openai}`);
      expect(JSON.parse(hit?.body ?? '{}').model).toBe(UPSTREAM.openai);
      return;
    }
    if (provider === 'anthropic') {
      const hit = doubles.anthropicHits.at(-1);
      expect(hit?.apiKey).toBe(keys.anthropic);
      expect(hit?.url).toBe('/v1/messages');
      expect(JSON.parse(hit?.body ?? '{}').model).toBe(UPSTREAM.anthropic);
      return;
    }
    if (provider === 'vertex') {
      const call = doubles.vertexCalls.at(-1);
      expect(call?.model).toBe(UPSTREAM.vertex);
      expect(call?.spec.tenantId).toBe(tenant.tenantId);
      expect(call?.spec.projectId).toBe(keys.vertexProject);
      expect(call?.spec.credentialJson).toBe(keys.vertexKey);
      return;
    }
    if (provider === 'dgx') {
      const hit = doubles.dgxHits.at(-1);
      expect(hit?.url.startsWith('https://dgx.lab.internal:8443/v1/chat/completions')).toBe(true);
      expect(hit?.authorization).toBe(`Bearer ${keys.dgx}`);
      expect(JSON.parse(hit?.body ?? '{}').model).toBe(UPSTREAM.dgx);
      return;
    }
    const hit = provider === 'xai' ? doubles.xaiHits.at(-1) : doubles.openrouterHits.at(-1);
    const prefix = provider === 'xai' ? 'https://api.x.ai/v1/chat/completions' : 'https://openrouter.ai/api/v1/chat/completions';
    expect(hit?.url.startsWith(prefix)).toBe(true);
    expect(hit?.authorization).toBe(`Bearer ${provider === 'xai' ? keys.xai : keys.openrouter}`);
    expect(hit?.model).toBe(UPSTREAM[provider]);
    expect(hit?.metadata).toBe(provider === 'openrouter' ? 'enabled' : '');
  }

  it('serves one JSON chat and one stream for each provider without a second call', async () => {
    for (const provider of PROVIDERS) {
      const before = snapshot(doubles);
      const response = await chat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'ok') }],
      });
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
      };
      expect(response.status).toBe(200);
      expect(body.choices?.[0]?.message?.content).toBe(TOKENS[provider].content);
      expect(body.usage).toEqual({
        prompt_tokens: TOKENS[provider].prompt,
        completion_tokens: TOKENS[provider].completion,
        total_tokens: TOKENS[provider].total,
      });
      expect(grewOnly(before, snapshot(doubles), provider)).toBe(true);
      expectSelected(provider);
      const stored = await latestAttempt(admin, tenant.tenantId);
      expect(stored).toMatchObject({
        status: 'succeeded',
        provider,
        deployment_name: names[provider],
        upstream_model: UPSTREAM[provider],
        stream_status: null,
        prompt_tokens: TOKENS[provider].prompt,
        completion_tokens: TOKENS[provider].completion,
        total_tokens: TOKENS[provider].total,
      });

      const streamBefore = snapshot(doubles);
      const streamed = await chat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        stream: true,
        messages: [{ role: 'user', content: sceneContent(provider, 'stream') }],
      });
      const text = await streamed.text();
      expect(streamed.status).toBe(200);
      expect(doneCount(text)).toBe(1);
      expect(grewOnly(streamBefore, snapshot(doubles), provider)).toBe(true);
      expectSelected(provider);
      const streamRow = await latestAttempt(admin, tenant.tenantId);
      expect(streamRow).toMatchObject({
        status: 'succeeded',
        stream_status: 'completed',
        provider,
        upstream_model: UPSTREAM[provider],
      });
      proof.push({ provider, json: response.status, streamDone: doneCount(text), upstream: streamRow.upstream_model });
    }
  });

  it('rejects an unsupported field before fetch and keeps auto on the stored alias', async () => {
    for (const provider of PROVIDERS) {
      const before = snapshot(doubles);
      const rejected = await chat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        top_p: 0.2,
        messages: [{ role: 'user', content: 'ok' }],
      });
      const body = (await rejected.json()) as { error?: { code?: string; param?: string } };
      expect(rejected.status).toBe(400);
      expect(body.error?.code).toBe('unsupported_parameter');
      expect(body.error?.param).toBe('top_p');
      expect(snapshot(doubles)).toEqual(before);
    }

    const beforeAuto = snapshot(doubles);
    const auto = await chat(port, tenant.tenantId, tenant.secret, {
      model: 'auto',
      messages: [{ role: 'user', content: 'ok' }],
    });
    const autoBody = (await auto.json()) as { choices?: Array<{ message?: { content?: string } }> };
    expect(auto.status).toBe(200);
    expect(autoBody.choices?.[0]?.message?.content).toBe('openai-ok');
    expect(grewOnly(beforeAuto, snapshot(doubles), 'openai')).toBe(true);
    expect(doubles.openaiHits.at(-1)?.authorization).toBe(`Bearer ${keys.openai}`);
    expect(JSON.parse(doubles.openaiHits.at(-1)?.body ?? '{}').model).toBe(UPSTREAM.openai);

    const beforeOff = snapshot(doubles);
    const disabled = await chat(port, tenant.tenantId, tenant.secret, {
      model: 'openai-off',
      messages: [{ role: 'user', content: 'ok' }],
    });
    const disabledBody = (await disabled.json()) as { error?: { code?: string } };
    expect(disabled.status).toBe(404);
    expect(disabledBody.error?.code).toBe('model_not_found');
    expect(snapshot(doubles)).toEqual(beforeOff);
    proof.push({ auto: 'openai', disabledDeploymentCalls: 0, capabilityRejected: PROVIDERS.length });
  });

  it('stores only integer usage and leaves a missing total unset', async () => {
    for (const provider of PROVIDERS) {
      const before = snapshot(doubles);
      const response = await chat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'nousage') }],
      });
      const body = (await response.json()) as { usage?: unknown };
      expect(response.status).toBe(200);
      expect(body.usage).toBeUndefined();
      expect(grewOnly(before, snapshot(doubles), provider)).toBe(true);
      const stored = await latestAttempt(admin, tenant.tenantId);
      expect(stored.prompt_tokens).toBeNull();
      expect(stored.completion_tokens).toBeNull();
      expect(stored.total_tokens).toBeNull();
      expect(stored.status).toBe('succeeded');
    }

    const partial = await chat(port, tenant.tenantId, tenant.secret, {
      model: names.openai,
      messages: [{ role: 'user', content: 'partial' }],
    });
    const partialBody = (await partial.json()) as { usage?: Record<string, number> };
    expect(partial.status).toBe(200);
    expect(partialBody.usage).toEqual({ prompt_tokens: 4, completion_tokens: 1 });
    expect(partialBody.usage?.total_tokens).toBeUndefined();
    const stored = await latestAttempt(admin, tenant.tenantId);
    expect(stored.prompt_tokens).toBe(4);
    expect(stored.completion_tokens).toBe(1);
    expect(stored.total_tokens).toBeNull();
    proof.push({ missingUsage: 'null', partialTotal: null });
  });

  it('normalizes timeout, connection failure, HTTP 429, and HTTP 5xx with one upstream call', async () => {
    const scenes: Array<{ scene: string; status: number; code: string | ((provider: ProviderName) => { status: number; code: string }) }> = [
      { scene: 'timeout', status: 504, code: 'timeout' },
      { scene: 'refuse', status: 502, code: 'upstream_error' },
      { scene: 'rate', status: 0, code: (provider) => RATE[provider] },
      { scene: 'down', status: 502, code: 'upstream_error' },
    ];
    for (const provider of PROVIDERS) {
      for (const scene of scenes) {
        const expected = typeof scene.code === 'function' ? scene.code(provider) : { status: scene.status, code: scene.code };
        const before = snapshot(doubles);
        const response = await chat(port, tenant.tenantId, tenant.secret, {
          model: names[provider],
          messages: [{ role: 'user', content: sceneContent(provider, scene.scene) }],
        });
        const body = (await response.json()) as { error?: { code?: string } };
        expect(response.status, `${provider} ${scene.scene}`).toBe(expected.status);
        expect(body.error?.code, `${provider} ${scene.scene}`).toBe(expected.code);
        expect(grewOnly(before, snapshot(doubles), provider), `${provider} ${scene.scene}`).toBe(true);
        const stored = await latestAttempt(admin, tenant.tenantId);
        expect(stored.provider).toBe(provider);
        expect(stored.upstream_model).toBe(UPSTREAM[provider]);
        expect(stored.error_code).toBe(expected.code);
      }
    }

    const beforeFallback = snapshot(doubles);
    const stillOpenAi = await chat(port, tenant.tenantId, tenant.secret, {
      model: names.openai,
      messages: [{ role: 'user', content: 'ok' }],
    });
    expect(stillOpenAi.status).toBe(200);
    expect(grewOnly(beforeFallback, snapshot(doubles), 'openai')).toBe(true);
    proof.push({ errors: 'timeout,refuse,429,5xx', fallbackCalls: 0 });
  });

  it('omits DONE when the caller cancels a stream', async () => {
    for (const provider of PROVIDERS) {
      const before = snapshot(doubles);
      const pending = openPost(
        port,
        tenant.tenantId,
        tenant.secret,
        chatPayload(names[provider], sceneContent(provider, 'cancel'), { stream: true }),
      );
      await waitFor(async () => {
        if (snapshot(doubles)[provider] !== before[provider] + 1) return false;
        const row = await latestAttempt(admin, tenant.tenantId);
        return row.stream_status === 'streaming' || row.stream_status === 'connecting';
      }, `${provider} cancel started`);
      pending.destroy();
      const body = await pending.settled;
      expect(doneCount(body.raw)).toBe(0);
      expect(body.raw.includes('[DONE]')).toBe(false);
      await waitFor(async () => {
        const row = await latestAttempt(admin, tenant.tenantId);
        return row.stream_status === 'client_aborted' && row.error_code === 'request_cancelled';
      }, `${provider} cancelled`);
      expect(grewOnly(before, snapshot(doubles), provider)).toBe(true);
      const stored = await latestAttempt(admin, tenant.tenantId);
      expect(stored.provider).toBe(provider);
      proof.push({ provider, cancelDone: doneCount(body.raw), streamStatus: stored.stream_status });
    }
  });
});
