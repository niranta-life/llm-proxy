import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../src/db/tenant-context.js';
import { SAMPLE_FACT_SQL, applyStoredRunTransition } from '../src/inference/evaluations.js';
import { preflightEvaluation, preflightRejection } from '../src/inference/evaluation-preflight.js';
import { planRunSteps, transitionItem, transitionRun } from '../src/inference/evaluation-state.js';
import { ProxyError } from '../src/inference/errors.js';
import {
  claimEvaluationJob,
  finishEvaluationJob,
  heartbeatEvaluationJob,
  pollEvaluationOnce,
} from '../src/inference/evaluation-worker.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const PROMPT = 'eval-slice-07a-prompt-token';
const COMPLETION = 'eval-slice-07a-completion-token';

type Tenant = { tenantId: string; secret: string; keyId: string; name: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;

function headers(tenant: Tenant, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
    ...extra,
  };
}

function plan(sampleIds: string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'weekly-qa',
    sampleCategory: 'general_qa',
    sampleIds,
    challengerDeployment: 'chat',
    budgetEstimate: '0.25',
    mode: 'dry_run',
    ...overrides,
  };
}

function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('error' in body)) return null;
  const error = (body as { error?: { code?: string | null } }).error;
  return error?.code ?? null;
}

describe('durable evaluation orchestration', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;

  beforeAll(async () => {
    openai = await startMockUpstream((_hit, _request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-eval', COMPLETION)));
    });
    admin = adminPool(db);
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  function setPolicy(
    tenantId: string,
    options: { deployments?: string; providers?: string; replay?: string; judge?: string } = {},
  ): void {
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        tenantId,
        '--mode',
        'encrypted_sample',
        '--content-capture',
        'true',
        '--replay',
        options.replay ?? 'true',
        '--judge-disclosure',
        options.judge ?? 'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '20',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        options.providers ?? 'openai',
        '--deployments',
        options.deployments ?? 'chat',
      ],
      cliEnv(),
    );
  }

  async function prepare(label: string): Promise<{ tenant: Tenant; sampleId: string }> {
    const tenant = provisionTenant(db, label);
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-eval-07a',
      deployment: 'chat',
      upstreamModel: 'gpt-eval',
      capabilities: 'temperature,stop',
    });
    setPolicy(tenant.tenantId);
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: {
        model: 'chat',
        messages: [{ role: 'user', content: PROMPT }],
        task: 'general_qa',
        temperature: 0,
      },
    });
    expect(response.statusCode).toBe(200);
    const stored = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    const sampleId = stored.rows[0]?.id;
    if (sampleId === undefined) throw new Error('sample was not stored');
    runCli(
      db,
      ['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '10'],
      cliEnv(),
    );
    return { tenant, sampleId };
  }

  async function cloneSample(
    sampleId: string,
    patch: { expired?: boolean; incomplete?: boolean; sourceLocation?: string | null },
  ): Promise<string> {
    const source = await admin.query<Record<string, unknown>>(
      `SELECT request_id, tenant_id, policy_id, policy_version, provider, deployment_name, data_classification,
              schema_version, size_bytes, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext, slot, task_category, input_size, complexity, text_only,
              required_capabilities, source_location
       FROM request_samples WHERE id = $1`,
      [sampleId],
    );
    const row = source.rows[0];
    if (row === undefined) throw new Error('sample is missing');
    const request = await admin.query<{ id: string }>(
      `INSERT INTO proxy_requests (
         tenant_id, deployment_id, deployment_config_version, connection_id, connection_version,
         requested_model, status, created_at, completed_at
       )
       SELECT tenant_id, deployment_id, deployment_config_version, connection_id, connection_version,
              requested_model, 'succeeded', now(), now()
       FROM proxy_requests WHERE id = $1
       RETURNING id::text AS id`,
      [row.request_id],
    );
    const requestId = request.rows[0]?.id;
    if (requestId === undefined) throw new Error('request was not cloned');
    const createdAt = patch.expired ? new Date(Date.now() - 2 * 86_400_000) : new Date();
    const expiresAt = patch.expired ? new Date(Date.now() - 86_400_000) : new Date(Date.now() + 86_400_000);
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO request_samples (
         id, tenant_id, request_id, policy_id, policy_version, provider, deployment_name,
         data_classification, schema_version, size_bytes, wrapping_key_version,
         wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
         content_iv, content_tag, content_ciphertext, created_at, expires_at,
         fingerprint, slot, task_category, input_size, complexity,
         exchange_complete, text_only, required_capabilities, source_location
       ) VALUES (
         gen_random_uuid(), $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17, $18,
         NULL, $19, $20, $21, $22,
         $23, $24, $25, $26
       ) RETURNING id::text AS id`,
      [
        row.tenant_id,
        requestId,
        row.policy_id,
        row.policy_version,
        row.provider,
        row.deployment_name,
        row.data_classification,
        row.schema_version,
        row.size_bytes,
        row.wrapping_key_version,
        row.wrapped_key_iv,
        row.wrapped_key_tag,
        row.wrapped_key_ciphertext,
        row.content_iv,
        row.content_tag,
        row.content_ciphertext,
        createdAt,
        expiresAt,
        row.slot,
        row.task_category,
        row.input_size,
        row.complexity,
        patch.incomplete === true ? false : true,
        row.text_only,
        row.required_capabilities,
        patch.sourceLocation === undefined ? row.source_location : patch.sourceLocation,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('clone was not stored');
    return id;
  }

  async function postPlan(tenant: Tenant, body: Record<string, unknown>, key?: string, path = '/internal/v1/evaluations') {
    return ctx.app.inject({
      method: 'POST',
      url: path,
      headers: headers(tenant, key === undefined ? {} : { 'idempotency-key': key }),
      payload: body,
    });
  }

  it('rejects an illegal run transition and accepts the same status again', () => {
    expect(transitionRun('queued', 'queued')).toEqual({ status: 'queued', applied: false });
    expect(transitionRun('queued', 'running').applied).toBe(true);
    expect(transitionItem('queued', 'cancelled')).toEqual({ status: 'cancelled', applied: true });
    expect(planRunSteps('queued', ['completed'])).toEqual(['running', 'completed']);
    expect(planRunSteps('queued', ['cancelled'])).toEqual(['cancelled']);
    expect(() => transitionRun('completed', 'queued')).toThrow(ProxyError);
    try {
      transitionRun('completed', 'queued');
    } catch (error) {
      expect(error).toBeInstanceOf(ProxyError);
      expect((error as ProxyError).code).toBe('illegal_transition');
    }
  });

  it('creates a dry run, pages it, and hides it from another tenant', async () => {
    const { tenant, sampleId } = await prepare('Eval Create');
    const other = provisionTenant(db, 'Eval Create Other');
    const created = await postPlan(tenant, plan([sampleId]), 'create-1');
    expect(created.statusCode).toBe(201);
    const run = created.json() as {
      id: string;
      status: string;
      modelExecution: string;
      queuedCount: number;
      itemCount: number;
      configSnapshot: Record<string, unknown>;
    };
    expect(run.status).toBe('queued');
    expect(run.modelExecution).toBe('off');
    expect(run.queuedCount).toBe(1);
    expect(run.itemCount).toBe(1);
    expect(JSON.stringify(run)).not.toContain(PROMPT);
    expect(JSON.stringify(run)).not.toContain(COMPLETION);
    expect(JSON.stringify(run.configSnapshot)).not.toContain('ciphertext');
    const replay = await postPlan(tenant, plan([sampleId]), 'create-1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: run.id, status: 'queued' });
    const conflict = await postPlan(tenant, plan([sampleId], { budgetEstimate: '0.5' }), 'create-1');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        message: 'The idempotency key was used with a different request.',
        type: 'invalid_request_error',
        param: 'Idempotency-Key',
        code: 'idempotency_conflict',
      },
    });
    const storedForKey = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM evaluation_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.tenantId, 'create-1'],
    );
    expect(storedForKey.rows[0]?.count).toBe('1');

    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations?limit=1',
      headers: headers(tenant),
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json() as { evaluations: Array<{ id: string }>; nextCursor: string | null };
    expect(page.evaluations.map((item) => item.id)).toEqual([run.id]);
    const second = await postPlan(tenant, plan([sampleId], { name: 'weekly-qa-2' }), 'create-2');
    expect(second.statusCode).toBe(201);
    const secondId = (second.json() as { id: string }).id;
    const newest = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations?limit=1',
      headers: headers(tenant),
    });
    expect(newest.statusCode).toBe(200);
    const newestPage = newest.json() as { evaluations: Array<{ id: string }>; nextCursor: string | null };
    expect(newestPage.evaluations.map((item) => item.id)).toEqual([secondId]);
    expect(newestPage.nextCursor).toBe(secondId);
    const next = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations?limit=1&cursor=${secondId}`,
      headers: headers(tenant),
    });
    expect(next.statusCode).toBe(200);
    const nextPage = next.json() as { evaluations: Array<{ id: string }> };
    expect(nextPage.evaluations.map((item) => item.id)).toEqual([run.id]);

    const items = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${run.id}/items`,
      headers: headers(tenant),
    });
    expect(items.statusCode).toBe(200);
    expect(items.json()).toMatchObject({
      items: [{ sampleId, ordinal: 0, status: 'queued', reasonCode: null }],
      nextCursor: null,
    });
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${run.id}`,
      headers: headers(other),
    });
    expect(foreign.statusCode).toBe(404);
    expect(errorCode(foreign.json())).toBe('not_found');
    const foreignItems = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${run.id}/items`,
      headers: headers(other),
    });
    expect(foreignItems.statusCode).toBe(404);
    const foreignList = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations',
      headers: headers(other),
    });
    expect(foreignList.json()).toEqual({ evaluations: [], nextCursor: null });
    const hidden = await withTenant(ctx.runtimePool, other.tenantId, (client) =>
      client.query(`SELECT id FROM evaluation_runs`),
    );
    expect(hidden.rows).toEqual([]);
  });

  it('replays a duplicate Idempotency-Key and rejects the same key with a different payload', async () => {
    const { tenant, sampleId } = await prepare('Eval Idempotency');
    const body = plan([sampleId]);
    const created = await postPlan(tenant, body, 'idem-1');
    expect(created.statusCode).toBe(201);
    const runId = (created.json() as { id: string }).id;
    const replay = await postPlan(tenant, body, 'idem-1');
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ id: runId, status: 'queued' });
    const conflict = await postPlan(tenant, plan([sampleId], { budgetEstimate: '0.5' }), 'idem-1');
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: {
        message: 'The idempotency key was used with a different request.',
        type: 'invalid_request_error',
        param: 'Idempotency-Key',
        code: 'idempotency_conflict',
      },
    });
    const stored = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM evaluation_runs WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenant.tenantId, 'idem-1'],
    );
    expect(stored.rows[0]?.count).toBe('1');
    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations',
      headers: headers(tenant),
    });
    expect(listed.statusCode).toBe(200);
    expect((listed.json() as { evaluations: Array<{ id: string }> }).evaluations.map((item) => item.id)).toEqual([
      runId,
    ]);
    expect(JSON.stringify(replay.json())).not.toContain(PROMPT);
    expect(JSON.stringify(conflict.json())).not.toContain(PROMPT);
  });

  it('rejects invalid plans with a specific code and does not decrypt', async () => {
    const { tenant, sampleId } = await prepare('Eval Reject');
    expect(SAMPLE_FACT_SQL).not.toContain('content_ciphertext');
    expect(SAMPLE_FACT_SQL).not.toContain('wrapped_key');
    await expect(
      withTenant(ctx.runtimePool, tenant.tenantId, (client) =>
        client.query(`SELECT content_ciphertext FROM request_samples WHERE id = $1`, [sampleId]),
      ),
    ).rejects.toThrow(/permission denied/i);

    const expired = await cloneSample(sampleId, { expired: true });
    const incomplete = await cloneSample(sampleId, { incomplete: true });
    const cases: Array<{ body: Record<string, unknown>; code: string }> = [
      { body: plan([randomUUID()]), code: 'sample_not_owned' },
      { body: plan([expired]), code: 'sample_expired' },
      { body: plan([incomplete]), code: 'sample_incomplete' },
      { body: plan([sampleId], { sampleCategory: 'coding' }), code: 'sample_category_mismatch' },
      { body: plan([sampleId], { mode: 'live' }), code: 'invalid_parameter' },
    ];
    for (const item of cases) {
      const response = await postPlan(tenant, item.body, undefined, '/internal/v1/evaluations/preflight');
      expect(response.statusCode, JSON.stringify(response.json())).toBe(400);
      expect(errorCode(response.json())).toBe(item.code);
      expect(JSON.stringify(response.json())).not.toContain(PROMPT);
    }

    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        tenant.tenantId,
        '--mode',
        'encrypted_sample',
        '--content-capture',
        'true',
        '--replay',
        'false',
        '--judge-disclosure',
        'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '20',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        'openai',
        '--deployments',
        'chat',
      ],
      cliEnv(),
    );
    const revoked = await postPlan(tenant, plan([sampleId]), undefined, '/internal/v1/evaluations/preflight');
    expect(errorCode(revoked.json())).toBe('replay_denied');

    const judgeTenant = (await prepare('Eval Judge')).tenant;
    const judgeSample = (await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 LIMIT 1`,
      [judgeTenant.tenantId],
    )).rows[0]?.id;
    if (judgeSample === undefined) throw new Error('judge sample is missing');
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        judgeTenant.tenantId,
        '--name',
        'judge',
        '--upstream-model',
        'gpt-judge',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature',
        '--enabled',
        'false',
      ],
      cliEnv(),
    );
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        judgeTenant.tenantId,
        '--mode',
        'encrypted_sample',
        '--content-capture',
        'true',
        '--replay',
        'true',
        '--judge-disclosure',
        'false',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '20',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        'openai',
        '--deployments',
        'chat',
      ],
      cliEnv(),
    );
    const disclosure = await postPlan(
      judgeTenant,
      plan([judgeSample], { judgeDeployment: 'judge' }),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(disclosure.json())).toBe('judge_disclosure_denied');
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        judgeTenant.tenantId,
        '--mode',
        'encrypted_sample',
        '--content-capture',
        'true',
        '--replay',
        'true',
        '--judge-disclosure',
        'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '20',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        'openai',
        '--deployments',
        'chat',
      ],
      cliEnv(),
    );
    const unauthorizedJudge = await postPlan(
      judgeTenant,
      plan([judgeSample], { judgeDeployment: 'judge' }),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(unauthorizedJudge.json())).toBe('deployment_unauthorized');

    const capability = (await prepare('Eval Capability')).tenant;
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        capability.tenantId,
        '--name',
        'weak',
        '--upstream-model',
        'gpt-weak',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'stop',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    setPolicy(capability.tenantId, { deployments: 'chat,weak' });
    const capabilitySample = (await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 LIMIT 1`,
      [capability.tenantId],
    )).rows[0]?.id;
    if (capabilitySample === undefined) throw new Error('capability sample is missing');
    const mismatch = await postPlan(
      capability,
      plan([capabilitySample], { challengerDeployment: 'weak', requiredCapabilities: ['temperature'] }),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(mismatch.json())).toBe('capability_mismatch');

    const providerTenant = await prepare('Eval Provider');
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        providerTenant.tenant.tenantId,
        '--mode',
        'encrypted_sample',
        '--content-capture',
        'true',
        '--replay',
        'true',
        '--judge-disclosure',
        'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '20',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        'anthropic',
        '--deployments',
        'chat',
      ],
      cliEnv(),
    );
    const providerDenied = await postPlan(
      providerTenant.tenant,
      plan([providerTenant.sampleId]),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(providerDenied.json())).toBe('provider_denied');

    const resident = await prepare('Eval Residency');
    const moved = await cloneSample(resident.sampleId, { sourceLocation: 'us-central1' });
    const residency = await postPlan(resident.tenant, plan([moved]), undefined, '/internal/v1/evaluations/preflight');
    expect(errorCode(residency.json())).toBe('residency_denied');

    const budget = await prepare('Eval Budget');
    const over = await postPlan(
      budget.tenant,
      plan([budget.sampleId], { budgetEstimate: '20' }),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(over.json())).toBe('budget_exceeded');

    const limited = await prepare('Eval Limits');
    runCli(
      db,
      ['set-tenant-limits', '--tenant-id', limited.tenant.tenantId, '--mode', 'hard', '--concurrent-requests', '1'],
      cliEnv(),
    );
    const secondSample = await cloneSample(limited.sampleId, {});
    const tooManyItems = await postPlan(
      limited.tenant,
      plan([limited.sampleId, secondSample]),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(tooManyItems.json())).toBe('item_limit_exceeded');
    const firstRun = await postPlan(limited.tenant, plan([limited.sampleId]), 'limit-run');
    expect(firstRun.statusCode).toBe(201);
    const tooManyRuns = await postPlan(
      limited.tenant,
      plan([limited.sampleId]),
      undefined,
      '/internal/v1/evaluations/preflight',
    );
    expect(errorCode(tooManyRuns.json())).toBe('run_limit_exceeded');

    const hugeIds = Array.from({ length: 101 }, () => randomUUID());
    const huge = await postPlan(tenant, plan(hugeIds), undefined, '/internal/v1/evaluations/preflight');
    expect(errorCode(huge.json())).toBe('item_limit_exceeded');
    const bulky = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations/preflight',
      headers: headers(tenant),
      payload: { name: 'x'.repeat(70_000) },
    });
    expect(bulky.statusCode).toBe(413);
    expect(errorCode(bulky.json())).toBe('request_too_large');
    expect(preflightRejection('budget_exceeded').body().error).toMatchObject({
      type: 'invalid_request_error',
      code: 'budget_exceeded',
      param: 'budget_estimate',
    });
    expect(() =>
      preflightEvaluation({
        sampleCategory: 'general_qa',
        sampleIds: ['00000000-0000-4000-8000-000000000001'],
        samples: [],
        challenger: null,
        judge: null,
        judgeRequested: false,
        policy: null,
        allowedRegions: [],
        requiredCapabilities: [],
        budgetEstimate: '1',
        budgetMode: null,
        budgetLimit: null,
        openRuns: 0,
        maxOpenRuns: 100,
        maxItems: 100,
        tenantItemCap: null,
      }),
    ).toThrow(ProxyError);
  });

  it('advances a dry run once across crash, duplicate delivery, and two workers', async () => {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let armModelGuard = false;
    globalThis.fetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      if (armModelGuard) {
        calls.push(String(input));
        throw new Error('model call');
      }
      return originalFetch(input, init);
    };
    try {
      const { tenant, sampleId } = await prepare('Eval Worker');
      const second = await cloneSample(sampleId, {});
      const created = await postPlan(tenant, plan([sampleId, second]), 'worker-1');
      expect(created.statusCode).toBe(201);
      const run = created.json() as { id: string };
      await admin.query(
        `UPDATE evaluation_jobs
         SET status = 'succeeded', locked_until = NULL
         WHERE run_id <> $1 AND status IN ('pending', 'running')`,
        [run.id],
      );
      const hitsBeforeWorker = openai.hits.length;
      armModelGuard = true;
      const claimed = await claimEvaluationJob(ctx.runtimePool, 'worker-a');
      expect(claimed).not.toBeNull();
      if (claimed === null) return;
      const beforeBeat = await admin.query<{ locked_until: Date }>(
        `SELECT locked_until FROM evaluation_jobs WHERE id = $1`,
        [claimed.jobId],
      );
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const beat = await heartbeatEvaluationJob(ctx.runtimePool, claimed.jobId, 'worker-a');
      expect(beat).not.toBeNull();
      const afterBeat = await admin.query<{ locked_until: Date }>(
        `SELECT locked_until FROM evaluation_jobs WHERE id = $1`,
        [claimed.jobId],
      );
      expect(afterBeat.rows[0]?.locked_until.getTime()).toBeGreaterThan(beforeBeat.rows[0]?.locked_until.getTime() ?? 0);
      await admin.query(`UPDATE evaluation_jobs SET locked_until = now() - interval '1 minute' WHERE id = $1`, [
        claimed.jobId,
      ]);
      const recovered = await pollEvaluationOnce(ctx.runtimePool, {
        workerId: 'worker-b',
        dryRun: true,
        executionEnabled: false,
      });
      expect(recovered.outcome).toBe('completed');
      const paired = await pollEvaluationOnce(ctx.runtimePool, {
        workerId: 'worker-c',
        dryRun: true,
        executionEnabled: false,
      });
      expect(paired.outcome).toBe('completed');
      const done = await withTenant(ctx.runtimePool, tenant.tenantId, (client) =>
        client.query<{ status: string; completed_count: number; queued_count: number }>(
          `SELECT status, completed_count, queued_count FROM evaluation_runs WHERE id = $1`,
          [run.id],
        ),
      );
      expect(done.rows[0]).toMatchObject({ status: 'completed', completed_count: 2, queued_count: 0 });
      await admin.query(
        `UPDATE evaluation_jobs
         SET status = 'running', locked_by = 'worker-b', locked_until = now() - interval '1 minute'
         WHERE run_id = $1`,
        [run.id],
      );
      const duplicate = await pollEvaluationOnce(ctx.runtimePool, {
        workerId: 'worker-d',
        dryRun: true,
        executionEnabled: false,
      });
      expect(duplicate.outcome).toBe('duplicate');
      const still = await admin.query<{ completed_count: number }>(
        `SELECT completed_count FROM evaluation_runs WHERE id = $1`,
        [run.id],
      );
      expect(still.rows[0]?.completed_count).toBe(2);
      const reasons = await admin.query<{ reason_code: string }>(
        `SELECT reason_code FROM evaluation_items WHERE run_id = $1 ORDER BY ordinal`,
        [run.id],
      );
      expect(reasons.rows.map((row) => row.reason_code)).toEqual(['dry_run', 'dry_run']);
      expect(calls).toEqual([]);
      expect(openai.hits.length).toBe(hitsBeforeWorker);
      armModelGuard = false;
      await admin.query(
        `UPDATE evaluation_jobs SET status = 'succeeded', locked_until = NULL WHERE status IN ('pending', 'running')`,
      );

      const concurrentTenant = await prepare('Eval Concurrent');
      const extra = await cloneSample(concurrentTenant.sampleId, {});
      const concurrentRun = await postPlan(
        concurrentTenant.tenant,
        plan([concurrentTenant.sampleId, extra]),
        'concurrent-1',
      );
      expect(concurrentRun.statusCode).toBe(201);
      const hitsBeforeConcurrent = openai.hits.length;
      armModelGuard = true;
      const together = await Promise.all([
        pollEvaluationOnce(ctx.runtimePool, { workerId: 'worker-e', dryRun: true, executionEnabled: false }),
        pollEvaluationOnce(ctx.runtimePool, { workerId: 'worker-f', dryRun: true, executionEnabled: false }),
      ]);
      expect(together.map((result) => result.outcome).sort()).toEqual(['completed', 'completed']);
      const concurrentId = (concurrentRun.json() as { id: string }).id;
      const concurrentRow = await admin.query<{ completed_count: number; status: string }>(
        `SELECT completed_count, status FROM evaluation_runs WHERE id = $1`,
        [concurrentId],
      );
      expect(concurrentRow.rows[0]).toMatchObject({ completed_count: 2, status: 'completed' });

      const skipped = await pollEvaluationOnce(ctx.runtimePool, {
        workerId: 'worker-off',
        dryRun: false,
        executionEnabled: false,
      });
      expect(skipped).toEqual({ claimed: false, outcome: 'skipped' });
      expect(calls).toEqual([]);
      expect(openai.hits.length).toBe(hitsBeforeConcurrent);
      await admin.query(
        `UPDATE evaluation_jobs SET status = 'succeeded', locked_until = NULL WHERE status = 'running'`,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('cancels a queued run, rejects an illegal stored transition, and keeps state on an outage', async () => {
    const { tenant, sampleId } = await prepare('Eval Cancel');
    const created = await postPlan(tenant, plan([sampleId]), 'cancel-1');
    const run = created.json() as { id: string; status: string };
    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluations/${run.id}/cancel`,
      headers: headers(tenant),
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json()).toMatchObject({
      id: run.id,
      status: 'cancelled',
      cancelledCount: 1,
      completedCount: 0,
      queuedCount: 0,
    });
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluations/${run.id}/cancel`,
      headers: headers(tenant),
      payload: {},
    });
    expect(again.json()).toMatchObject({ status: 'cancelled' });
    await admin.query(
      `UPDATE evaluation_jobs
       SET status = 'succeeded', locked_until = NULL
       WHERE run_id <> $1 AND status IN ('pending', 'running')`,
      [run.id],
    );
    const idle = await pollEvaluationOnce(ctx.runtimePool, {
      workerId: 'worker-cancel',
      dryRun: true,
      executionEnabled: false,
    });
    expect(idle.outcome).toBe('idle');
    const items = await admin.query<{ status: string; reason_code: string }>(
      `SELECT status, reason_code FROM evaluation_items WHERE run_id = $1`,
      [run.id],
    );
    expect(items.rows).toEqual([{ status: 'cancelled', reason_code: 'cancelled' }]);

    const illegalTenant = await prepare('Eval Illegal');
    const illegalRun = await postPlan(illegalTenant.tenant, plan([illegalTenant.sampleId]), 'illegal-1');
    const illegalId = (illegalRun.json() as { id: string }).id;
    await expect(
      withTenant(ctx.runtimePool, illegalTenant.tenant.tenantId, (client) =>
        applyStoredRunTransition(client, illegalId, 'completed'),
      ),
    ).rejects.toThrow(ProxyError);
    const unchanged = await withTenant(ctx.runtimePool, illegalTenant.tenant.tenantId, (client) =>
      client.query<{ status: string }>(`SELECT status FROM evaluation_runs WHERE id = $1`, [illegalId]),
    );
    expect(unchanged.rows[0]?.status).toBe('queued');
    const same = await withTenant(ctx.runtimePool, illegalTenant.tenant.tenantId, (client) =>
      applyStoredRunTransition(client, illegalId, 'queued'),
    );
    expect(same.status).toBe('queued');
    await expect(
      admin.query(`UPDATE evaluation_runs SET config_snapshot = config_snapshot || '{"prompt":"x"}'::jsonb WHERE id = $1`, [
        illegalId,
      ]),
    ).rejects.toThrow(/immutable/i);

    const aborted = new AbortController();
    aborted.abort();
    const stopped = await pollEvaluationOnce(ctx.runtimePool, {
      workerId: 'worker-stop',
      dryRun: true,
      executionEnabled: false,
      signal: aborted.signal,
    });
    expect(stopped).toEqual({ claimed: false, outcome: 'idle' });
    const afterStop = await admin.query<{ status: string }>(`SELECT status FROM evaluation_runs WHERE id = $1`, [
      illegalId,
    ]);
    expect(afterStop.rows[0]?.status).toBe('queued');

    const outageApp = await createTestApp(db, { inferenceEnabled: false, credentialKey });
    await outageApp.runtimePool.end();
    const outage = await outageApp.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${illegalId}`,
      headers: headers(illegalTenant.tenant),
    });
    expect(outage.statusCode).toBe(500);
    expect(outage.json()).toEqual({
      error: {
        message: 'The request failed.',
        type: 'server_error',
        param: null,
        code: 'internal_error',
      },
    });
    await outageApp.app.close();
    await outageApp.authPool.end();
    const stillQueued = await admin.query<{ status: string }>(`SELECT status FROM evaluation_runs WHERE id = $1`, [
      illegalId,
    ]);
    expect(stillQueued.rows[0]?.status).toBe('queued');

    const dead = new (await import('pg')).default.Pool({
      host: '127.0.0.1',
      port: 1,
      database: 'llm_proxy',
      user: 'llm_runtime',
      password: 'x',
      connectionTimeoutMillis: 500,
      max: 1,
    });
    await expect(
      pollEvaluationOnce(dead, { workerId: 'worker-dead', dryRun: true, executionEnabled: false }),
    ).rejects.toThrow();
    await dead.end().catch(() => undefined);
    expect(stillQueued.rows[0]?.status).toBe('queued');
    expect(readFileSync(`${projectRoot}/src/index.ts`, 'utf8')).not.toContain('evaluation-worker');
    expect(readFileSync(`${projectRoot}/Dockerfile`, 'utf8')).toContain('dist/index.js');
    const version = await admin.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version = '021_evaluation_orchestration.sql'`,
    );
    expect(version.rows.map((row) => row.version)).toEqual(['021_evaluation_orchestration.sql']);
    const prior = await admin.query(
      `SELECT version FROM schema_migrations WHERE version IN ('018_sample_capture.sql', '019_sample_retention.sql', '020_stream_samples.sql') ORDER BY version`,
    );
    expect(prior.rows.map((row: { version: string }) => row.version)).toEqual([
      '018_sample_capture.sql',
      '019_sample_retention.sql',
      '020_stream_samples.sql',
    ]);
    expect(finishEvaluationJob).toBeTypeOf('function');
  });

  it('stores a second version when the definition name already exists', async () => {
    const { tenant, sampleId } = await prepare('Eval Version');
    const first = await postPlan(tenant, plan([sampleId]), 'version-1');
    expect(first.statusCode).toBe(201);
    const firstRun = first.json() as { id: string; definitionId: string; definitionVersion: number };
    expect(firstRun.definitionVersion).toBe(1);
    const second = await postPlan(tenant, plan([sampleId]), 'version-2');
    expect(second.statusCode).toBe(201);
    const secondRun = second.json() as {
      id: string;
      definitionId: string;
      definitionVersion: number;
      status: string;
    };
    expect(secondRun.status).toBe('queued');
    expect(secondRun.definitionId).toBe(firstRun.definitionId);
    expect(secondRun.definitionVersion).toBe(2);
    expect(secondRun.id).not.toBe(firstRun.id);
  });

  it('does not deadlock when cancel runs with the worker', async () => {
    const { tenant, sampleId } = await prepare('Eval Lock');
    for (let index = 0; index < 6; index += 1) {
      const sample = index === 0 ? sampleId : await cloneSample(sampleId, {});
      const created = await postPlan(tenant, plan([sample]), `lock-${index}`);
      expect(created.statusCode).toBe(201);
      const runId = (created.json() as { id: string }).id;
      await admin.query(
        `UPDATE evaluation_jobs
         SET status = 'succeeded', locked_until = NULL
         WHERE run_id <> $1 AND status IN ('pending', 'running')`,
        [runId],
      );
      const [polled, cancelled] = await Promise.all([
        pollEvaluationOnce(ctx.runtimePool, {
          workerId: `worker-lock-${index}`,
          dryRun: true,
          executionEnabled: false,
        }),
        ctx.app.inject({
          method: 'POST',
          url: `/internal/v1/evaluations/${runId}/cancel`,
          headers: headers(tenant),
          payload: {},
        }),
      ]);
      const body = JSON.stringify(cancelled.json());
      expect(body.toLowerCase()).not.toContain('deadlock');
      expect(['idle', 'completed', 'cancelled', 'duplicate']).toContain(polled.outcome);
      const stored = await admin.query<{
        status: string;
        completed_count: number;
        cancelled_count: number;
        queued_count: number;
        running_count: number;
      }>(
        `SELECT status, completed_count, cancelled_count, queued_count, running_count
         FROM evaluation_runs WHERE id = $1`,
        [runId],
      );
      const row = stored.rows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(['cancelled', 'completed']).toContain(row.status);
      expect(row.queued_count + row.running_count + row.completed_count + row.cancelled_count).toBe(1);
      if (row.status === 'cancelled') {
        expect(cancelled.statusCode).toBe(200);
        expect(row.cancelled_count).toBe(1);
        expect(row.completed_count).toBe(0);
      } else {
        expect(cancelled.statusCode).toBe(409);
        expect(errorCode(cancelled.json())).toBe('illegal_transition');
        expect(row.completed_count).toBe(1);
      }
    }
  });
});
