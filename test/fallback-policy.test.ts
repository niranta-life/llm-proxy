import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createTestApp, loadTestDatabase, runCli } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

type Script = 'ok' | '503' | '429' | '500' | 'hang' | 'partial' | 'sse';

type Tenant = ReturnType<typeof provisionTenant>;

const PARTIAL = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"fb-primary","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n`;

function authHeaders(tenantId: string, secret: string): Record<string, string> {
  return {
    'x-tenant-id': tenantId,
    authorization: `Bearer ${secret}`,
    'content-type': 'application/json',
  };
}

function sseBody(model: string, content: string): string {
  const head = { id: 'chatcmpl-fallback', object: 'chat.completion.chunk', created: 1_700_000_000, model };
  return [
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function modelOf(hit: MockHit): string {
  return (JSON.parse(hit.body) as { model?: string }).model ?? '';
}

describe('policy-controlled fallback', () => {
  const db = loadTestDatabase();
  const pools: Array<{ end: () => Promise<unknown> }> = [];
  const scripts = new Map<string, Script>();
  let vertexCalls = 0;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: Awaited<ReturnType<typeof createTestApp>>;
  let admin: pg.Pool;
  let main: Tenant;
  let plain: Tenant;
  let foreign: Tenant;
  const secret = 'sk-test-fallback-main';

  function cli(args: string[]): Record<string, unknown> {
    return runCli(db, args, cliEnv()) as Record<string, unknown>;
  }

  function addDeployment(
    tenantId: string,
    name: string,
    model: string,
    capabilities = 'temperature,max_tokens',
    enabled = true,
  ): void {
    cli([
      'register-deployment',
      '--tenant-id',
      tenantId,
      '--name',
      name,
      '--upstream-model',
      model,
      '--timeout-ms',
      '5000',
      '--capabilities',
      capabilities,
      '--enabled',
      enabled ? 'true' : 'false',
    ]);
  }

  async function markLive(tenantId: string, name: string, status = 'validated_live'): Promise<void> {
    await admin.query(
      `UPDATE model_deployments SET validation_status = $3 WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name, status],
    );
  }

  async function ready(tenantId: string, name: string, limit = 128): Promise<void> {
    await markLive(tenantId, name);
    cli([
      'set-deployment-context-limit',
      '--tenant-id',
      tenantId,
      '--deployment',
      name,
      '--context-limit',
      String(limit),
    ]);
    cli([
      'set-deployment-data-collection',
      '--tenant-id',
      tenantId,
      '--deployment',
      name,
      '--data-collection',
      'allow',
    ]);
  }

  function setPolicy(
    tenantId: string,
    deployments: string[],
    options: {
      enabled?: boolean;
      failures?: string[];
      max?: number;
      capabilities?: string;
      providers?: string;
      regions?: string[];
      min?: number;
      data?: string;
    } = {},
  ): Record<string, unknown> {
    const args = [
      'set-fallback-policy',
      '--tenant-id',
      tenantId,
      '--alias',
      'auto',
      '--enabled',
      options.enabled === false ? 'false' : 'true',
      '--deployments',
      deployments.join(','),
      '--failures',
      (options.failures ?? ['unavailable']).join(','),
      '--max-attempts',
      String(options.max ?? 2),
      '--capabilities',
      options.capabilities ?? 'temperature',
      '--providers',
      options.providers ?? 'openai',
      '--data-collection',
      options.data ?? 'allow',
      '--min-remaining-deadline-ms',
      String(options.min ?? 0),
    ];
    if (options.regions !== undefined && options.regions.length > 0) args.push('--regions', options.regions.join(','));
    return cli(args);
  }

  function wideDeadlines(): void {
    cli([
      'set-execution-policy',
      '--tenant-id',
      main.tenantId,
      '--deployment',
      'fb-primary',
      '--retries',
      'false',
      '--connection-deadline-ms',
      '5000',
      '--attempt-deadline-ms',
      '5000',
      '--total-deadline-ms',
      '5000',
      '--initial-backoff-ms',
      '0',
      '--max-backoff-ms',
      '0',
    ]);
  }

  async function chat(tenant: Tenant, model: string, extra: Record<string, unknown> = {}) {
    const { content, ...rest } = extra;
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: authHeaders(tenant.tenantId, tenant.secret),
      payload: chatPayload(model, typeof content === 'string' ? content : 'hi', rest),
    });
  }

  function calledModels(): string[] {
    return mock.hits.map((hit) => modelOf(hit));
  }

  beforeAll(async () => {
    mock = await startMockUpstream((_hit, _request, response) => {
      const parsed = JSON.parse(_hit.body) as { model?: string; stream?: boolean };
      const model = parsed.model ?? '';
      const script = scripts.get(model) ?? 'ok';
      if (script === 'hang') return;
      if (script === 'partial') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(PARTIAL);
        return;
      }
      if (script === 'sse') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseBody(model, 'from-secondary'));
        return;
      }
      if (script === '503' || script === '429' || script === '500') {
        const status = script === '503' ? 503 : script === '429' ? 429 : 500;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(model, `from-${model}`)));
    });
    main = provisionTenant(db, 'Fallback Main');
    plain = provisionTenant(db, 'Fallback Plain');
    foreign = provisionTenant(db, 'Fallback Foreign');
    registerInference(db, {
      tenantId: main.tenantId,
      apiKey: secret,
      deployment: 'fb-primary',
      upstreamModel: 'fb-primary',
      capabilities: 'temperature,max_tokens',
    });
    registerInference(db, {
      tenantId: plain.tenantId,
      apiKey: 'sk-test-fallback-plain',
      deployment: 'plain-chat',
      upstreamModel: 'plain-primary',
      capabilities: 'temperature,max_tokens',
    });
    registerInference(db, {
      tenantId: foreign.tenantId,
      apiKey: 'sk-test-fallback-foreign',
      deployment: 'foreign-chat',
      upstreamModel: 'foreign-primary',
      capabilities: 'temperature,max_tokens',
    });
    addDeployment(main.tenantId, 'fb-secondary', 'fb-secondary');
    addDeployment(main.tenantId, 'fb-left', 'fb-left');
    addDeployment(main.tenantId, 'fb-right', 'fb-right');
    addDeployment(main.tenantId, 'fb-off', 'fb-off', 'temperature,max_tokens', false);
    addDeployment(main.tenantId, 'fb-narrow', 'fb-narrow', 'temperature');
    addDeployment(main.tenantId, 'fb-small', 'fb-small');
    admin = adminPool(db);
    pools.push(admin);
    for (const name of ['fb-secondary', 'fb-left', 'fb-right', 'fb-off', 'fb-narrow', 'fb-small']) {
      await ready(main.tenantId, name, name === 'fb-small' ? 4 : 128);
    }
    enableStreaming(db, { tenantId: main.tenantId, deployment: 'fb-primary' });
    enableStreaming(db, { tenantId: main.tenantId, deployment: 'fb-secondary' });
    const email = 'fallback-vertex@example.iam.gserviceaccount.com';
    const vertexKey = JSON.stringify({ client_email: email, private_key: `-----BEGIN PRIVATE KEY-----\n${'k'.repeat(80)}\n-----END PRIVATE KEY-----\n` });
    cli([
      'register-vertex-connection',
      '--tenant-id',
      main.tenantId,
      '--api-key',
      vertexKey,
      '--project',
      'fallback-vertex-proj',
      '--location',
      'europe-west4',
      '--service-account',
      email,
    ]);
    cli([
      'register-deployment',
      '--tenant-id',
      main.tenantId,
      '--provider',
      'vertex',
      '--name',
      'fb-vertex',
      '--upstream-model',
      'gemini-fallback',
      '--timeout-ms',
      '5000',
      '--capabilities',
      'temperature,max_tokens',
      '--enabled',
      'true',
    ]);
    await ready(main.tenantId, 'fb-vertex');
    cli([
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      'fb-primary',
      '--effective-at',
      '2020-01-01T00:00:00.000Z',
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '0.01',
      '--output-rate',
      '0.02',
    ]);
    cli([
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      'fb-secondary',
      '--effective-at',
      '2020-01-01T00:00:00.000Z',
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '0.01',
      '--output-rate',
      '0.02',
    ]);
    cli(['set-tenant-budget', '--tenant-id', main.tenantId, '--mode', 'observe', '--monthly-amount', '1000000']);
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: mock.baseUrl,
      credentialKey,
      vertexClientFactory: () => {
        vertexCalls += 1;
        throw new Error('vertex was called');
      },
    });
    pools.push(ctx.authPool, ctx.runtimePool);
  });

  beforeEach(() => {
    mock.hits.length = 0;
    scripts.clear();
    vertexCalls = 0;
  });

  afterAll(async () => {
    if (mock !== undefined) await mock.close();
    if (ctx !== undefined) await ctx.app.close();
    await Promise.all(pools.map((pool) => pool.end()));
  });

  it('stores a versioned policy and falls back for one alias', async () => {
    const absent = cli(['show-fallback-policy', '--tenant-id', plain.tenantId, '--alias', 'auto']);
    expect(absent).toEqual({ attached: false });
    const first = setPolicy(main.tenantId, ['fb-secondary'], {
      failures: ['unavailable'],
      max: 5,
      capabilities: 'temperature',
    });
    const second = setPolicy(main.tenantId, ['fb-secondary'], {
      failures: ['unavailable', 'rate_limit', 'timeout_after_dispatch', 'upstream_error'],
      max: 5,
    });
    expect(second.policyVersion).not.toBe(first.policyVersion);
    const shown = cli(['show-fallback-policy', '--tenant-id', main.tenantId, '--alias', 'auto']);
    expect(shown).toMatchObject({
      policyId: second.policyId,
      policyVersion: second.policyVersion,
      enabled: true,
      maxAttempts: 5,
      allowedFailures: ['unavailable', 'rate_limit', 'timeout_after_dispatch', 'upstream_error'],
      requiredCapabilities: ['temperature'],
      allowedProviders: ['openai'],
      allowedRegions: [],
      dataCollection: 'allow',
      minRemainingDeadlineMs: 0,
      deployments: ['fb-secondary'],
    });
    scripts.set('fb-primary', '503');
    const content = 'x'.repeat(4000);
    const response = await chat(main, 'auto', { content, max_tokens: 16 });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('from-fb-secondary');
    expect(response.json().model).toBe('fb-secondary');
    expect(calledModels()).toEqual(['fb-primary', 'fb-secondary']);
    expect(response.headers['x-request-id']).toBeTruthy();
    expect(response.headers['x-deployment']).toBe('fb-secondary');
    expect(response.headers['x-attempt-count']).toBe('2');
    expect(response.headers['x-fallback']).toBe('true');
    const visible = `${JSON.stringify(response.headers)}\n${response.body}`;
    expect(visible).not.toContain(secret);
    expect(visible).not.toContain(String(shown.policyId));
    expect(visible).not.toContain('allowedFailures');
    expect(visible).not.toContain('minRemainingDeadlineMs');
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/metrics/attempts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      headers: authHeaders(main.tenantId, main.secret),
    });
    expect(history.statusCode).toBe(200);
    const attempts = (history.json() as { attempts: Array<Record<string, unknown>> }).attempts.filter(
      (item) => item.model === 'fb-primary' || item.model === 'fb-secondary',
    );
    const pair = attempts.slice(-2);
    expect(pair.map((item) => item.triggerReason)).toEqual(['primary', 'unavailable']);
    expect(pair[0]?.deployment).toBe('fb-primary');
    expect(pair[1]?.deployment).toBe('fb-secondary');
    expect(pair[1]?.fallbackPolicyVersion).toBe(second.policyVersion);
    expect(pair[0]?.durationMs).toEqual(expect.any(Number));
    expect(pair[1]?.durationMs).toEqual(expect.any(Number));
    expect(pair[0]?.reservedAmount).toEqual(expect.any(String));
    expect(pair[1]?.reservedAmount).toEqual(expect.any(String));
    expect(pair[0]?.attemptId).not.toBe(pair[1]?.attemptId);
    const money = await admin.query<{
      ordinal: number;
      model: string;
      cost_status: string | null;
      amount: string | null;
      reserved: string | null;
    }>(
      `SELECT a.attempt_ordinal AS ordinal, a.upstream_model AS model, ac.cost_status, ac.amount::text AS amount,
              br.reserved_amount::text AS reserved
       FROM model_attempts a
       LEFT JOIN attempt_costs ac ON ac.tenant_id = a.tenant_id AND ac.attempt_id = a.id
       LEFT JOIN budget_reservations br ON br.tenant_id = a.tenant_id AND br.attempt_id = a.id
       WHERE a.tenant_id = $1 AND a.request_id = $2
       ORDER BY a.attempt_ordinal`,
      [main.tenantId, response.headers['x-request-id']],
    );
    expect(money.rows).toHaveLength(2);
    expect(new Set(money.rows.map((row) => row.model))).toEqual(new Set(['fb-primary', 'fb-secondary']));
    expect(money.rows.every((row) => row.reserved !== null)).toBe(true);
    expect(money.rows[1]).toMatchObject({ model: 'fb-secondary', cost_status: 'estimated' });
    const known = await admin.query<{ match: boolean }>(
      `SELECT amount = 0.07::numeric AS match FROM attempt_costs WHERE tenant_id = $1 AND attempt_id = $2`,
      [main.tenantId, pair[1]?.attemptId],
    );
    expect(known.rows[0]?.match).toBe(true);
  });

  it('does not fall back when the policy is missing or disabled', async () => {
    scripts.set('plain-primary', '503');
    const plainResponse = await chat(plain, 'auto');
    expect(plainResponse.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['plain-primary']);
    mock.hits.length = 0;
    setPolicy(main.tenantId, ['fb-secondary'], { enabled: false, failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    const disabled = await chat(main, 'auto');
    expect(disabled.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
    expect(disabled.headers['x-fallback']).toBe('false');
  });

  it('does not change an explicit deployment', async () => {
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'fb-primary');
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
    expect(response.headers['x-fallback']).toBe('false');
    expect(response.headers['x-attempt-count']).toBe('1');
  });

  it('skips a secondary that is not enabled', async () => {
    setPolicy(main.tenantId, ['fb-off', 'fb-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'auto');
    expect(response.statusCode).toBe(200);
    expect(calledModels()).toEqual(['fb-primary', 'fb-secondary']);
  });

  it('does not call a deployment owned by another tenant', async () => {
    const foreignId = await admin.query<{ id: string }>(
      `SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'foreign-chat'`,
      [foreign.tenantId],
    );
    const foreignDeploymentId = foreignId.rows[0]?.id;
    expect(foreignDeploymentId).toBeTruthy();
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO fallback_policies (
         tenant_id, policy_version, enabled, max_attempts, allowed_failures, required_capabilities,
         allowed_providers, allowed_regions, data_collection, min_remaining_deadline_ms, deployment_ids
       )
       VALUES (
         $1,
         (SELECT COALESCE(MAX(policy_version), 0) + 1 FROM fallback_policies WHERE tenant_id = $1),
         true, 2, ARRAY['unavailable']::text[],
         ARRAY['temperature']::text[], ARRAY['openai']::text[], ARRAY[]::text[], 'allow', 0,
         ARRAY[$2]::uuid[]
       )
       RETURNING id`,
      [main.tenantId, foreignDeploymentId],
    );
    expect(inserted.rows[0]?.id).toBeTruthy();
    await admin.query(
      `UPDATE model_aliases SET fallback_policy_id = $2 WHERE tenant_id = $1 AND alias = 'auto'`,
      [main.tenantId, inserted.rows[0]?.id],
    );
    scripts.set('fb-primary', '503');
    scripts.set('foreign-primary', 'ok');
    const response = await chat(main, 'auto');
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
  });

  it('skips a secondary that lacks a required capability', async () => {
    setPolicy(main.tenantId, ['fb-narrow'], { failures: ['unavailable'], capabilities: 'max_tokens' });
    scripts.set('fb-primary', '503');
    scripts.set('fb-narrow', 'ok');
    const response = await chat(main, 'auto');
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
  });

  it('skips a secondary whose stored context limit is below the token need', async () => {
    setPolicy(main.tenantId, ['fb-small'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    scripts.set('fb-small', 'ok');
    const response = await chat(main, 'auto', { max_tokens: 16, content: 'short' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
  });

  it('selects the first approved deployment and reverses with the stored list', async () => {
    setPolicy(main.tenantId, ['fb-left', 'fb-right'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    const left = await chat(main, 'auto', { content: 'order-left' });
    expect(left.statusCode).toBe(200);
    expect(left.json().choices[0].message.content).toBe('from-fb-left');
    expect(calledModels()).toEqual(['fb-primary', 'fb-left']);
    mock.hits.length = 0;
    setPolicy(main.tenantId, ['fb-right', 'fb-left'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    const right = await chat(main, 'auto', { content: 'order-right' });
    expect(right.statusCode).toBe(200);
    expect(right.json().choices[0].message.content).toBe('from-fb-right');
    expect(calledModels()).toEqual(['fb-primary', 'fb-right']);
  });

  it.each(['validated_mock', 'valid', 'unvalidated', 'invalid'])(
    'does not call a secondary marked %s',
    async (status) => {
      try {
        await markLive(main.tenantId, 'fb-secondary', status);
        setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable'] });
        scripts.set('fb-primary', '503');
        scripts.set('fb-secondary', 'ok');
        const response = await chat(main, 'auto', { content: `status-${status}` });
        expect(response.statusCode).toBeGreaterThanOrEqual(500);
        expect(calledModels()).toEqual(['fb-primary']);
      } finally {
        await markLive(main.tenantId, 'fb-secondary');
      }
    },
  );

  it('does not call a secondary in a region outside the policy', async () => {
    setPolicy(main.tenantId, ['fb-vertex'], {
      failures: ['unavailable'],
      providers: 'openai,vertex',
      regions: ['us-central1'],
    });
    scripts.set('fb-primary', '503');
    const response = await chat(main, 'auto', { content: 'region-check' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
    expect(vertexCalls).toBe(0);
  });

  it('does not call a secondary with an unknown hard-budget price', async () => {
    const tenant = provisionTenant(db, 'Fallback Unknown Price');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fallback-unknown',
      deployment: 'known-primary',
      upstreamModel: 'fb-known-primary',
      capabilities: 'temperature,max_tokens',
    });
    addDeployment(tenant.tenantId, 'unknown-secondary', 'fb-unknown-secondary');
    await ready(tenant.tenantId, 'unknown-secondary');
    cli([
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      'fb-known-primary',
      '--effective-at',
      '2020-01-01T00:00:00.000Z',
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '0.01',
    ]);
    cli([
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      'fb-unknown-secondary',
      '--effective-at',
      '2020-01-01T00:00:00.000Z',
      '--source',
      'fixture',
      '--status',
      'verified',
      '--allocated-rate',
      '0.01',
    ]);
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '100']);
    setPolicy(tenant.tenantId, ['unknown-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-known-primary', '503');
    scripts.set('fb-unknown-secondary', 'ok');
    const response = await chat(tenant, 'auto', { content: 'price' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-known-primary']);
  });

  it('does not call a secondary that does not fit the hard budget', async () => {
    const tenant = provisionTenant(db, 'Fallback Tight Budget');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fallback-tight',
      deployment: 'cheap-primary',
      upstreamModel: 'fb-cheap-primary',
      capabilities: 'temperature,max_tokens',
    });
    addDeployment(tenant.tenantId, 'costly-secondary', 'fb-costly-secondary');
    await ready(tenant.tenantId, 'costly-secondary');
    cli([
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      'fb-cheap-primary',
      '--effective-at',
      '2020-01-01T00:00:00.000Z',
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '0.01',
    ]);
    cli([
      'register-price',
      '--provider',
      'openai',
      '--upstream-model',
      'fb-costly-secondary',
      '--effective-at',
      '2020-01-01T00:00:00.000Z',
      '--source',
      'fixture',
      '--status',
      'verified',
      '--input-rate',
      '10',
    ]);
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '1']);
    setPolicy(tenant.tenantId, ['costly-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-cheap-primary', '503');
    scripts.set('fb-costly-secondary', 'ok');
    const response = await chat(tenant, 'auto', { content: 'hi' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-cheap-primary']);
  });

  it('calls the secondary when the only hard request cap is one', async () => {
    const tenant = provisionTenant(db, 'Fallback Request Cap');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fallback-cap',
      deployment: 'fb-cap-primary',
      upstreamModel: 'fb-cap-primary',
      capabilities: 'temperature,max_tokens',
    });
    addDeployment(tenant.tenantId, 'fb-cap-secondary', 'fb-cap-secondary');
    await ready(tenant.tenantId, 'fb-cap-secondary');
    cli([
      'set-tenant-limits',
      '--tenant-id',
      tenant.tenantId,
      '--mode',
      'hard',
      '--concurrent-requests',
      '1',
      '--lease-ms',
      '120000',
    ]);
    setPolicy(tenant.tenantId, ['fb-cap-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-cap-primary', '503');
    scripts.set('fb-cap-secondary', 'ok');
    const response = await chat(tenant, 'auto', { content: 'one-request-cap' });
    expect(response.statusCode).toBe(200);
    expect(response.json().choices[0].message.content).toBe('from-fb-cap-secondary');
    expect(response.json().model).toBe('fb-cap-secondary');
    expect(calledModels()).toEqual(['fb-cap-primary', 'fb-cap-secondary']);
    expect(response.headers['x-deployment']).toBe('fb-cap-secondary');
    expect(response.headers['x-attempt-count']).toBe('2');
    expect(response.headers['x-fallback']).toBe('true');
  });

  it('calls the secondary when the only hard stream cap is one', async () => {
    const tenant = provisionTenant(db, 'Fallback Stream Cap');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-fallback-stream-cap',
      deployment: 'fb-stream-cap-primary',
      upstreamModel: 'fb-stream-cap-primary',
      capabilities: 'temperature,max_tokens',
    });
    addDeployment(tenant.tenantId, 'fb-stream-cap-secondary', 'fb-stream-cap-secondary');
    await ready(tenant.tenantId, 'fb-stream-cap-secondary');
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'fb-stream-cap-primary' });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'fb-stream-cap-secondary' });
    cli([
      'set-tenant-limits',
      '--tenant-id',
      tenant.tenantId,
      '--mode',
      'hard',
      '--concurrent-streams',
      '1',
      '--lease-ms',
      '120000',
    ]);
    setPolicy(tenant.tenantId, ['fb-stream-cap-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-stream-cap-primary', '503');
    scripts.set('fb-stream-cap-secondary', 'sse');
    const response = await chat(tenant, 'auto', { stream: true, content: 'one-stream-cap' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('from-secondary');
    expect(response.body).toContain('data: [DONE]');
    expect(calledModels()).toEqual(['fb-stream-cap-primary', 'fb-stream-cap-secondary']);
    expect(response.headers['x-deployment']).toBe('fb-stream-cap-secondary');
    expect(response.headers['x-attempt-count']).toBe('2');
    expect(response.headers['x-fallback']).toBe('true');
  });

  it('does not call a secondary whose circuit breaker is open', async () => {
    cli([
      'set-deployment-breaker',
      '--tenant-id',
      main.tenantId,
      '--deployment',
      'fb-secondary',
      '--enabled',
      'true',
      '--window-ms',
      '60000',
      '--min-samples',
      '2',
      '--failure-threshold',
      '1',
      '--cooldown-ms',
      '60000',
      '--max-probes',
      '1',
    ]);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'open', state_reason = 'failure_threshold', cooldown_until = now() + interval '1 hour'
       WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'fb-secondary')`,
      [main.tenantId],
    );
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'auto', { content: 'breaker-open' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
    cli([
      'reset-deployment-breaker',
      '--tenant-id',
      main.tenantId,
      '--deployment',
      'fb-secondary',
    ]);
    cli([
      'set-deployment-breaker',
      '--tenant-id',
      main.tenantId,
      '--deployment',
      'fb-secondary',
      '--enabled',
      'false',
    ]);
  });

  it('falls back after a dispatched timeout and after a 429 when those categories are allowed', async () => {
    cli([
      'set-execution-policy',
      '--tenant-id',
      main.tenantId,
      '--deployment',
      'fb-primary',
      '--retries',
      'false',
      '--connection-deadline-ms',
      '5000',
      '--attempt-deadline-ms',
      '200',
      '--total-deadline-ms',
      '5000',
      '--initial-backoff-ms',
      '0',
      '--max-backoff-ms',
      '0',
    ]);
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['timeout_after_dispatch'] });
    scripts.set('fb-primary', 'hang');
    scripts.set('fb-secondary', 'ok');
    const timed = await chat(main, 'auto', { content: 'timeout-after' });
    expect(timed.statusCode).toBe(200);
    expect(timed.json().choices[0].message.content).toBe('from-fb-secondary');
    expect(calledModels()).toEqual(['fb-primary', 'fb-secondary']);
    mock.hits.length = 0;
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['rate_limit'] });
    scripts.set('fb-primary', '429');
    scripts.set('fb-secondary', 'ok');
    const limited = await chat(main, 'auto', { content: 'rate-limit' });
    expect(limited.statusCode).toBe(200);
    expect(limited.json().model).toBe('fb-secondary');
    expect(calledModels()).toEqual(['fb-primary', 'fb-secondary']);
    wideDeadlines();
  });

  it('does not fall back for a category outside the approved set', async () => {
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable'] });
    scripts.set('fb-primary', '500');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'auto', { content: 'upstream-error' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
  });

  it('stops at two attempts when the stored maximum is higher and the secondary fails', async () => {
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable', 'upstream_error'], max: 5 });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', '500');
    const response = await chat(main, 'auto', { content: 'both-fail' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary', 'fb-secondary']);
    expect(response.headers['x-attempt-count']).toBe('2');
    expect(response.headers['x-fallback']).toBe('true');
  });

  it('makes one attempt when the stored maximum is one', async () => {
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable'], max: 1 });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'auto', { content: 'max-one' });
    expect(calledModels()).toEqual(['fb-primary']);
    expect(response.headers['x-attempt-count']).toBe('1');
  });

  it('does not start a secondary when the remaining deadline is below the policy minimum', async () => {
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable'], min: 600_000 });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'auto', { content: 'deadline-min' });
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
    expect(calledModels()).toEqual(['fb-primary']);
  });

  it('does not start a secondary after the end-to-end deadline', async () => {
    cli([
      'set-execution-policy',
      '--tenant-id',
      main.tenantId,
      '--deployment',
      'fb-primary',
      '--retries',
      'false',
      '--connection-deadline-ms',
      '5000',
      '--attempt-deadline-ms',
      '5000',
      '--total-deadline-ms',
      '200',
      '--initial-backoff-ms',
      '0',
      '--max-backoff-ms',
      '0',
    ]);
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['total_deadline', 'timeout_after_dispatch'] });
    scripts.set('fb-primary', 'hang');
    scripts.set('fb-secondary', 'ok');
    const response = await chat(main, 'auto', { content: 'total-deadline' });
    expect(response.statusCode).toBe(504);
    expect(calledModels()).toEqual(['fb-primary']);
    const stored = await admin.query<{ failure_class: string | null }>(
      `SELECT failure_class FROM model_attempts
       WHERE tenant_id = $1 AND upstream_model = 'fb-primary'
       ORDER BY created_at DESC LIMIT 1`,
      [main.tenantId],
    );
    expect(stored.rows[0]?.failure_class).toBe('total_deadline');
    wideDeadlines();
  });

  it('falls back before any downstream byte and refuses a switch after output starts', async () => {
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['unavailable', 'upstream_error', 'stream_started'] });
    scripts.set('fb-primary', '503');
    scripts.set('fb-secondary', 'sse');
    const early = await chat(main, 'auto', { stream: true, content: 'sse-before' });
    expect(early.statusCode).toBe(200);
    expect(early.body).toContain('from-secondary');
    expect(early.body).toContain('data: [DONE]');
    expect(calledModels()).toEqual(['fb-primary', 'fb-secondary']);
    expect(early.headers['x-deployment']).toBe('fb-secondary');
    expect(early.headers['x-attempt-count']).toBe('2');
    expect(early.headers['x-fallback']).toBe('true');
    mock.hits.length = 0;
    scripts.set('fb-primary', 'partial');
    scripts.set('fb-secondary', 'sse');
    const late = await chat(main, 'auto', { stream: true, content: 'sse-after' });
    expect(calledModels()).toEqual(['fb-primary']);
    expect(late.body).not.toContain('data: [DONE]');
    expect(late.body).not.toContain('fb-secondary');
    expect(late.body).not.toContain('from-secondary');
    const stored = await admin.query<{ failure_class: string | null }>(
      `SELECT failure_class FROM model_attempts
       WHERE tenant_id = $1 AND upstream_model = 'fb-primary'
       ORDER BY created_at DESC LIMIT 1`,
      [main.tenantId],
    );
    expect(stored.rows[0]?.failure_class).toBe('stream_started');
  });

  it('does not fall back when the caller cancels', async () => {
    wideDeadlines();
    setPolicy(main.tenantId, ['fb-secondary'], { failures: ['cancelled', 'unavailable'] });
    scripts.set('fb-primary', 'hang');
    scripts.set('fb-secondary', 'ok');
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('port is missing');
    let release: (() => void) | undefined;
    const arrived = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = mock.hits.length;
    const waiter = setInterval(() => {
      if (mock.hits.length > previous) {
        release?.();
        clearInterval(waiter);
      }
    }, 10);
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: authHeaders(main.tenantId, main.secret),
      body: chatPayload('auto', 'cancel-me'),
      signal: controller.signal,
    });
    await arrived;
    controller.abort();
    await expect(pending).rejects.toThrow();
    clearInterval(waiter);
    const started = Date.now();
    let errorCode: string | null = null;
    while (Date.now() - started < 5000) {
      const stored = await admin.query<{ error_code: string | null }>(
        `SELECT error_code FROM model_attempts
         WHERE tenant_id = $1 AND upstream_model = 'fb-primary'
         ORDER BY created_at DESC LIMIT 1`,
        [main.tenantId],
      );
      errorCode = stored.rows[0]?.error_code ?? null;
      if (errorCode === 'request_cancelled') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(calledModels().filter((model) => model === 'fb-secondary')).toEqual([]);
    expect(mock.hits.filter((hit) => modelOf(hit) === 'fb-primary').length).toBe(1);
    expect(errorCode).toBe('request_cancelled');
  });
});
