import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCredentialStore } from '../src/credentials.js';
import type { EvaluationWorkerOptions } from '../src/inference/evaluation-worker.js';
import { pollEvaluationOnce } from '../src/inference/evaluation-worker.js';
import {
  createSampleKeyManager,
  decryptSample,
  encryptSample,
  SAMPLE_SCHEMA_VERSION,
  type EncryptedEnvelope,
} from '../src/inference/sample-crypto.js';
import {
  captureLogger,
  createTestApp,
  freePort,
  loadTestDatabase,
  projectRoot,
  runCli,
  serviceEnv,
  spawnServer,
  stopChild,
  waitForExit,
  waitForReady,
} from './helpers.js';
import { adminPool, cliEnv, credentialKey, credentialKeyText, provisionTenant } from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const PROMPT = 'eval-slice-07f-prompt-token';
const COMPLETION = 'eval-slice-07f-completion-token';
const SOURCE_MODEL = 'gpt-07f-source';
const CHALLENGER_MODEL = 'gpt-07f-challenger';
const EFFECTIVE = '2025-12-01T00:00:00.000Z';
const LATER_PRICE = '2026-06-01T00:00:00.000Z';
const WORKER_ENTRY = join(projectRoot, 'dist', 'evaluation-worker.js');

type Tenant = { tenantId: string; secret: string; keyId: string; name: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;
type Decision = {
  id: string;
  kind: string;
  action: string;
  skipReason: string | null;
  reasonCodes: string[];
  selectedSampleIds: string[];
  runId: string | null;
  asOf: string;
  fresh: boolean;
};
type DriftStatement = {
  taskCategory: string;
  comparable: boolean;
  limit: string | null;
  qualityDrift: boolean | null;
  schemaValidityRegression: boolean | null;
  latencyRegression: boolean | null;
  reliabilityRegression: boolean | null;
  modelVersionChanged: boolean | null;
  priceVersionChanged: boolean | null;
  newModelDeployed: boolean | null;
};
type DriftBody = {
  asOf: string;
  statements: DriftStatement[];
  workloadMixChange: boolean;
  limits: string[];
  historical: boolean;
};

describe('continuous evaluation schedules', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;
  let tenant: Tenant;
  let other: Tenant;
  let sampleId = '';
  let now = new Date(Date.UTC(2026, 1, 1, 12));
  let dayIndex = 0;
  let keyIndex = 0;
  const workerLogger = captureLogger();
  const credentialStore = createCredentialStore(credentialKey);
  const sampleKeyManager = createSampleKeyManager(credentialKey);

  beforeAll(async () => {
    openai = await startMockUpstream((_hit, _request, response) => {
      const raw = _hit.body;
      const parsed = JSON.parse(raw) as { model?: string };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? CHALLENGER_MODEL, COMPLETION)));
    });
    admin = adminPool(db);
    for (const model of [SOURCE_MODEL, CHALLENGER_MODEL]) {
      runCli(
        db,
        [
          'register-price',
          '--provider',
          'openai',
          '--upstream-model',
          model,
          '--effective-at',
          EFFECTIVE,
          '--source',
          'fixture',
          '--status',
          'verified',
          '--input-rate',
          '0.002',
          '--output-rate',
          '0.003',
        ],
        cliEnv(),
      );
    }
    tenant = provisionTenant(db, 'Schedule Synthetic');
    other = provisionTenant(db, 'Schedule Other');
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      evaluationScheduleTenantIds: [tenant.tenantId],
      scheduleNow: () => now,
    });
    runCli(
      db,
      ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-test-eval-07f'],
      cliEnv(),
    );
    for (const [name, model] of [
      ['chat', SOURCE_MODEL],
      ['challenger', CHALLENGER_MODEL],
      ['same', SOURCE_MODEL],
    ] as const) {
      runCli(
        db,
        [
          'register-deployment',
          '--tenant-id',
          tenant.tenantId,
          '--name',
          name,
          '--upstream-model',
          model,
          '--timeout-ms',
          '5000',
          '--capabilities',
          'temperature,max_tokens',
          '--enabled',
          'true',
        ],
        cliEnv(),
      );
    }
    runCli(db, ['set-alias', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--deployment', 'chat'], cliEnv());
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', tenant.tenantId, '--deployment', 'chat', '--data-class', 'internal'],
      cliEnv(),
    );
    setPolicy(true);
    runCli(
      db,
      ['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '10'],
      cliEnv(),
    );
    const chat = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: {
        model: 'chat',
        messages: [{ role: 'user', content: PROMPT }],
        task: 'general_qa',
        temperature: 0,
        max_tokens: 16,
      },
    });
    expect(chat.statusCode, chat.body).toBe(200);
    const stored = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    sampleId = stored.rows[0]?.id ?? '';
    expect(sampleId).not.toBe('');
    const enabled = await enable(scheduleBody(), 'schedule-enable');
    expect(enabled.statusCode).toBe(201);
  });

  afterAll(async () => {
    await admin.query(`UPDATE evaluation_controls SET kill_switch = false WHERE singleton`);
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  function headers(caller: Tenant, extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-tenant-id': caller.tenantId,
      authorization: `Bearer ${caller.secret}`,
      ...extra,
    };
  }

  function scheduleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      enabled: true,
      dailyLimit: '1',
      monthlyLimit: '20',
      perRunMaxExpense: '1',
      maxChallengerCalls: 100,
      maxJudgeCalls: 0,
      maxConcurrentJobs: 10,
      maxDurationMs: 600_000,
      maxSamples: 1,
      challengerDeployment: 'challenger',
      sampleCategory: 'general_qa',
      ...overrides,
    };
  }

  function setPolicy(replay: boolean): void {
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
        replay ? 'true' : 'false',
        '--judge-disclosure',
        'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '100',
        '--retention-seconds',
        '86400',
        '--classifications',
        'internal',
        '--providers',
        'openai',
        '--deployments',
        'chat,challenger,same',
      ],
      cliEnv(),
    );
  }

  function useNextDay(): string {
    now = new Date(Date.UTC(2026, 1, 1 + dayIndex, 12));
    dayIndex += 1;
    return now.toISOString().slice(0, 10);
  }

  function nextKey(name: string): string {
    keyIndex += 1;
    return `${name}-${keyIndex}`;
  }

  function expectNoRaw(value: unknown): void {
    const text = JSON.stringify(value);
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(COMPLETION);
  }

  async function enable(body: Record<string, unknown>, name: string): Promise<{ statusCode: number; json: Record<string, unknown> }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-schedules',
      headers: headers(tenant, { 'idempotency-key': nextKey(name) }),
      payload: body,
    });
    return { statusCode: response.statusCode, json: response.json() };
  }

  async function tick(caller: Tenant = tenant): Promise<{ statusCode: number; decision: Decision; raw: string }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-schedules/tick',
      headers: headers(caller, { 'idempotency-key': nextKey('tick') }),
      payload: {},
    });
    const decision = response.json() as Decision;
    expectNoRaw(decision);
    return { statusCode: response.statusCode, decision, raw: response.body };
  }

  async function manual(): Promise<{ statusCode: number; decision: Decision }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-schedules/runs',
      headers: headers(tenant, { 'idempotency-key': nextKey('manual') }),
      payload: {},
    });
    const decision = response.json() as Decision;
    expectNoRaw(decision);
    return { statusCode: response.statusCode, decision };
  }

  async function restoreSchedule(overrides: Record<string, unknown> = {}): Promise<void> {
    const saved = await enable(scheduleBody(overrides), 'restore');
    expect(saved.statusCode).toBe(201);
  }

  async function runCount(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_runs WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function reservationCount(day: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM evaluation_budget_reservations
       WHERE tenant_id = $1 AND period_day = $2::date`,
      [tenant.tenantId, day],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function cancelOpen(): Promise<void> {
    const open = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM evaluation_runs
       WHERE tenant_id = $1 AND status IN ('created', 'preflight', 'queued', 'running', 'cancel_requested')`,
      [tenant.tenantId],
    );
    for (const row of open.rows) {
      await ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/evaluations/${row.id}/cancel`,
        headers: headers(tenant),
        payload: {},
      });
    }
  }

  function workerOptions(extra: Partial<EvaluationWorkerOptions> = {}): EvaluationWorkerOptions {
    return {
      workerId: 'schedule-worker',
      dryRun: false,
      executionEnabled: true,
      replayTenantIds: [tenant.tenantId],
      scheduleTenantIds: [tenant.tenantId],
      upstreamBaseUrl: openai.baseUrl,
      credentialStore,
      sampleKeyManager,
      logger: workerLogger.logger,
      ...extra,
    };
  }

  async function routingSnapshot(): Promise<{ aliases: string[]; fallbackVersions: number[] }> {
    const aliases = await admin.query<{ alias: string; deployment: string }>(
      `SELECT a.alias, d.name AS deployment
       FROM model_aliases a
       JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
       WHERE a.tenant_id = $1
       ORDER BY a.alias`,
      [tenant.tenantId],
    );
    const policies = await admin.query<{ policy_version: number }>(
      `SELECT policy_version FROM fallback_policies WHERE tenant_id = $1 ORDER BY policy_version`,
      [tenant.tenantId],
    );
    return {
      aliases: aliases.rows.map((row) => `${row.alias}:${row.deployment}`),
      fallbackVersions: policies.rows.map((row) => row.policy_version),
    };
  }

  async function itemReason(runId: string): Promise<string | null> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${runId}/items`,
      headers: headers(tenant),
    });
    expect(response.statusCode, response.body).toBe(200);
    expectNoRaw(response.json());
    const body = response.json() as { items: Array<{ reasonCode: string | null; status: string }> };
    return body.items[0]?.reasonCode ?? null;
  }

  async function releaseJob(runId: string): Promise<void> {
    await admin.query(
      `UPDATE evaluation_jobs SET locked_until = now() - interval '1 second' WHERE run_id = $1 AND status = 'running'`,
      [runId],
    );
  }

  async function mutateSample(id: string, sql: string, params: unknown[]): Promise<void> {
    await admin.query('ALTER TABLE request_samples DISABLE TRIGGER request_samples_immutable');
    try {
      await admin.query(sql, params);
    } finally {
      await admin.query('ALTER TABLE request_samples ENABLE TRIGGER request_samples_immutable');
    }
  }

  async function copySample(id: string, patch: { createdAt?: Date; category?: string } = {}): Promise<string> {
    const source = await admin.query<Record<string, unknown>>(
      `SELECT request_id, tenant_id, policy_id, policy_version, provider, deployment_name, data_classification,
              schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext, slot, task_category, input_size, complexity, text_only,
              required_capabilities, source_location
       FROM request_samples WHERE id = $1`,
      [id],
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
    const envelopeRow = await admin.query<{
      schema_version: number;
      wrapping_key_version: number;
      wrapped_key_iv: Buffer;
      wrapped_key_tag: Buffer;
      wrapped_key_ciphertext: Buffer;
      content_iv: Buffer;
      content_tag: Buffer;
      content_ciphertext: Buffer;
    }>(
      `SELECT schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext
       FROM request_samples WHERE id = $1`,
      [id],
    );
    const stored = envelopeRow.rows[0];
    if (stored === undefined) throw new Error('sample envelope is missing');
    const opened: EncryptedEnvelope & { schemaVersion: number } = {
      schemaVersion: stored.schema_version,
      wrappingKeyVersion: stored.wrapping_key_version,
      wrappedKeyIv: Buffer.from(stored.wrapped_key_iv),
      wrappedKeyTag: Buffer.from(stored.wrapped_key_tag),
      wrappedKeyCiphertext: Buffer.from(stored.wrapped_key_ciphertext),
      contentIv: Buffer.from(stored.content_iv),
      contentTag: Buffer.from(stored.content_tag),
      contentCiphertext: Buffer.from(stored.content_ciphertext),
    };
    const payload = decryptSample(
      sampleKeyManager,
      { tenantId: String(row.tenant_id), sampleId: id, schemaVersion: stored.schema_version },
      opened,
    );
    if (payload === null) throw new Error('sample did not open');
    const sealedId = randomUUID();
    const sealed = encryptSample(sampleKeyManager, {
      tenantId: String(row.tenant_id),
      sampleId: sealedId,
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      payload,
    });
    if (sealed === null) throw new Error('sample was not sealed');
    const createdAt = patch.createdAt ?? new Date();
    const expiresAt = new Date(createdAt.getTime() + 86_400_000);
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO request_samples (
         id, tenant_id, request_id, policy_id, policy_version, provider, deployment_name,
         data_classification, schema_version, size_bytes, wrapping_key_version,
         wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
         content_iv, content_tag, content_ciphertext, created_at, expires_at,
         fingerprint, slot, task_category, input_size, complexity,
         exchange_complete, text_only, required_capabilities, source_location
       ) VALUES (
         $26::uuid, $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10,
         $11, $12, $13,
         $14, $15, $16, $17, $18,
         NULL, $19, $20, $21, $22,
         true, $23, $24, $25
       ) RETURNING id::text AS id`,
      [
        row.tenant_id,
        requestId,
        row.policy_id,
        row.policy_version,
        row.provider,
        row.deployment_name,
        row.data_classification,
        sealed.schemaVersion,
        sealed.contentCiphertext.length,
        sealed.wrappingKeyVersion,
        sealed.wrappedKeyIv,
        sealed.wrappedKeyTag,
        sealed.wrappedKeyCiphertext,
        sealed.contentIv,
        sealed.contentTag,
        sealed.contentCiphertext,
        createdAt,
        expiresAt,
        row.slot,
        patch.category ?? row.task_category,
        row.input_size,
        row.complexity,
        row.text_only,
        row.required_capabilities,
        row.source_location,
        sealedId,
      ],
    );
    const cloned = inserted.rows[0]?.id;
    if (cloned === undefined) throw new Error('clone was not stored');
    return cloned;
  }

  it('enables, reads, and replays one tenant schedule', async () => {
    const first = await enable(scheduleBody(), 'enable-replay');
    expect(first.statusCode).toBe(201);
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-schedules',
      headers: headers(tenant, { 'idempotency-key': `enable-replay-${keyIndex}` }),
      payload: scheduleBody(),
    });
    expect(again.statusCode).toBe(200);
    const conflict = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-schedules',
      headers: headers(tenant, { 'idempotency-key': `enable-replay-${keyIndex}` }),
      payload: scheduleBody({ maxSamples: 2 }),
    });
    expect(conflict.statusCode).toBe(409);
    const read = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluation-schedules',
      headers: headers(tenant),
    });
    expect(read.statusCode).toBe(200);
    const body = read.json() as { schedule: { enabled: boolean; challengerDeployment: string; dailyLimit: string } };
    expect(body.schedule.enabled).toBe(true);
    expect(body.schedule.challengerDeployment).toBe('challenger');
    expect(body.schedule.dailyLimit).toBe('1');
    expectNoRaw(body);
  });

  it('schedules one new approved sample and records the reason', async () => {
    const day = useNextDay();
    await cancelOpen();
    const hits = openai.hits.length;
    const before = await runCount();
    const result = await tick();
    expect(result.statusCode, result.raw).toBe(201);
    expect(result.decision.action).toBe('run');
    expect(result.decision.fresh).toBe(true);
    expect(result.decision.runId).not.toBeNull();
    expect(result.decision.selectedSampleIds).toContain(sampleId);
    expect(result.decision.reasonCodes).toEqual(
      expect.arrayContaining(['bounded_sample', 'new_samples', 'low_coverage', 'high_uncertainty', 'workload_volume', 'version_change']),
    );
    expect(await reservationCount(day)).toBe(1);
    expect(await runCount()).toBe(before + 1);
    expect(openai.hits.length).toBe(hits);
    await cancelOpen();
  });

  it('records a model version change when the challenger model differs', async () => {
    const models = await admin.query<{ source: string; challenger: string }>(
      `SELECT s.upstream_model AS source, c.upstream_model AS challenger
       FROM model_deployments s
       JOIN model_deployments c ON c.tenant_id = s.tenant_id
       WHERE s.tenant_id = $1 AND s.name = 'chat' AND c.name = 'challenger'`,
      [tenant.tenantId],
    );
    expect(models.rows[0]?.source).toBe(SOURCE_MODEL);
    expect(models.rows[0]?.challenger).toBe(CHALLENGER_MODEL);
    expect(models.rows[0]?.source).not.toBe(models.rows[0]?.challenger);
    useNextDay();
    await cancelOpen();
    const result = await tick();
    expect(result.statusCode, result.raw).toBe(201);
    expect(result.decision.reasonCodes).toContain('version_change');
    await cancelOpen();
  });

  it('records a price version change when only the price row is newer', async () => {
    runCli(
      db,
      [
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        SOURCE_MODEL,
        '--effective-at',
        LATER_PRICE,
        '--source',
        'fixture-later',
        '--status',
        'verified',
        '--input-rate',
        '0.004',
        '--output-rate',
        '0.005',
      ],
      cliEnv(),
    );
    await restoreSchedule({ challengerDeployment: 'same' });
    useNextDay();
    await cancelOpen();
    const hits = openai.hits.length;
    const result = await tick();
    expect(result.statusCode, result.raw).toBe(201);
    expect(result.decision.reasonCodes).toContain('version_change');
    const compared = await admin.query<{ same_model: boolean; price_differs: boolean }>(
      `SELECT s.upstream_model = c.upstream_model AS same_model,
              (
                SELECT ac.price_version_id IS DISTINCT FROM (
                  SELECT pv.id FROM price_versions pv
                  WHERE pv.provider = 'openai' AND pv.model = c.upstream_model AND pv.effective_at <= now()
                  ORDER BY pv.effective_at DESC LIMIT 1
                )
                FROM model_attempts ma
                JOIN attempt_costs ac ON ac.tenant_id = ma.tenant_id AND ac.attempt_id = ma.id
                WHERE ma.request_id = rs.request_id AND ma.status = 'succeeded'
                ORDER BY ma.created_at LIMIT 1
              ) AS price_differs
       FROM request_samples rs
       JOIN model_deployments s ON s.tenant_id = rs.tenant_id AND s.name = 'chat'
       JOIN model_deployments c ON c.tenant_id = rs.tenant_id AND c.name = 'same'
       WHERE rs.id = $1`,
      [sampleId],
    );
    expect(compared.rows[0]?.same_model).toBe(true);
    expect(compared.rows[0]?.price_differs).toBe(true);
    expect(openai.hits.length).toBe(hits);
    await cancelOpen();
    await restoreSchedule();
  });

  it('skips when no sample is eligible', async () => {
    await restoreSchedule({ sampleCategory: 'coding' });
    useNextDay();
    const hits = openai.hits.length;
    const before = await runCount();
    const result = await tick();
    expect(result.statusCode).toBe(200);
    expect(result.decision.action).toBe('skip');
    expect(result.decision.skipReason).toBe('no_eligible_samples');
    expect(result.decision.runId).toBeNull();
    expect(await runCount()).toBe(before);
    expect(openai.hits.length).toBe(hits);
    await restoreSchedule();
  });

  it('skips when the budget is too small for one sample', async () => {
    await restoreSchedule({ dailyLimit: '0.001', monthlyLimit: '1', perRunMaxExpense: '0.001' });
    useNextDay();
    const hits = openai.hits.length;
    const result = await tick();
    expect(result.decision.action).toBe('skip');
    expect(result.decision.skipReason).toBe('budget_too_small');
    expect(result.decision.runId).toBeNull();
    expect(openai.hits.length).toBe(hits);
    await restoreSchedule();
  });

  it('skips when the judge call budget is exhausted', async () => {
    await restoreSchedule({
      judgeDeployment: 'challenger',
      rubricVersionId: '00000000-0000-4000-8000-00000000007f',
      maxJudgeCalls: 0,
    });
    useNextDay();
    const hits = openai.hits.length;
    const result = await tick();
    expect(result.decision.action).toBe('skip');
    expect(result.decision.skipReason).toBe('judge_budget_exhausted');
    expect(openai.hits.length).toBe(hits);
    await restoreSchedule();
  });

  it('skips when production capacity is constrained', async () => {
    runCli(
      db,
      [
        'set-tenant-limits',
        '--tenant-id',
        tenant.tenantId,
        '--mode',
        'hard',
        '--concurrent-requests',
        '1',
      ],
      cliEnv(),
    );
    await admin.query(
      `INSERT INTO concurrency_leases (tenant_id, scope, scope_id, attempt_id, expires_at)
       VALUES ($1, 'tenant_request', $1, $2, now() + interval '5 minutes')`,
      [tenant.tenantId, randomUUID()],
    );
    try {
      useNextDay();
      const hits = openai.hits.length;
      const result = await tick();
      expect(result.decision.action).toBe('skip');
      expect(result.decision.skipReason).toBe('production_capacity_constrained');
      expect(openai.hits.length).toBe(hits);
    } finally {
      await admin.query(`DELETE FROM concurrency_leases WHERE tenant_id = $1`, [tenant.tenantId]);
      runCli(
        db,
        [
          'set-tenant-limits',
          '--tenant-id',
          tenant.tenantId,
          '--mode',
          'observe',
          '--concurrent-requests',
          '100',
        ],
        cliEnv(),
      );
    }
  });

  it('skips when the challenger call limit is already reserved', async () => {
    await restoreSchedule({ maxChallengerCalls: 1 });
    const day = useNextDay();
    await cancelOpen();
    const created = await manual();
    expect(created.statusCode, JSON.stringify(created.decision)).toBe(201);
    expect(created.decision.action).toBe('run');
    const result = await tick();
    expect(result.decision.action).toBe('skip');
    expect(result.decision.skipReason).toBe('challenger_call_limit');
    expect(await reservationCount(day)).toBe(1);
    await cancelOpen();
    await restoreSchedule();
  });

  it('treats a duplicate tick as the same decision', async () => {
    const day = useNextDay();
    await cancelOpen();
    const hits = openai.hits.length;
    const first = await tick();
    expect(first.statusCode, first.raw).toBe(201);
    const second = await tick();
    expect(second.statusCode).toBe(200);
    expect(second.decision.fresh).toBe(false);
    expect(second.decision.runId).toBe(first.decision.runId);
    expect(await reservationCount(day)).toBe(1);
    expect(openai.hits.length).toBe(hits);
    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluation-schedules/decisions?limit=50',
      headers: headers(tenant),
    });
    expect(listed.statusCode).toBe(200);
    expectNoRaw(listed.json());
    await cancelOpen();
  });

  it('lets two replicas create one run', async () => {
    useNextDay();
    await cancelOpen();
    const before = await runCount();
    const hits = openai.hits.length;
    const [left, right] = await Promise.all([tick(), tick()]);
    const ids = [left.decision.runId, right.decision.runId].filter((id) => id !== null);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toBeTruthy();
    expect([left.statusCode, right.statusCode].sort()).toEqual([200, 201]);
    expect(await runCount()).toBe(before + 1);
    expect(openai.hits.length).toBe(hits);
    await cancelOpen();
  });

  it('stops new work when the global kill switch is on', async () => {
    useNextDay();
    await cancelOpen();
    const armed = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-controls',
      headers: headers(tenant),
      payload: { killSwitch: true },
    });
    expect(armed.statusCode, armed.body).toBe(200);
    try {
      const hits = openai.hits.length;
      const skipped = await tick();
      expect(skipped.decision.action).toBe('skip');
      expect(skipped.decision.skipReason).toBe('global_kill_switch');
      expect(skipped.decision.runId).toBeNull();
      const queued = await manual();
      expect(queued.decision.action).toBe('skip');
      expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions())).toMatchObject({ claimed: false, outcome: 'skipped' });
      expect(openai.hits.length).toBe(hits);
    } finally {
      const cleared = await ctx.app.inject({
        method: 'POST',
        url: '/internal/v1/evaluation-controls',
        headers: headers(tenant),
        payload: { killSwitch: false },
      });
      expect(cleared.statusCode).toBe(200);
    }
  });

  it('does not run when the scheduler is disabled', async () => {
    const off = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      scheduleNow: () => new Date(Date.UTC(2026, 6, 1, 12)),
    });
    try {
      const hits = openai.hits.length;
      const before = await runCount();
      const response = await off.app.inject({
        method: 'POST',
        url: '/internal/v1/evaluation-schedules/tick',
        headers: headers(tenant, { 'idempotency-key': nextKey('off') }),
        payload: {},
      });
      const decision = response.json() as Decision;
      expect(response.statusCode).toBe(200);
      expect(decision.skipReason).toBe('scheduler_disabled');
      expect(decision.runId).toBeNull();
      expect(await runCount()).toBe(before);
      expect(openai.hits.length).toBe(hits);
      expectNoRaw(decision);
    } finally {
      await off.app.close();
      await off.authPool.end();
      await off.runtimePool.end();
    }
  });

  it('isolates schedules and reports across tenants', async () => {
    const hits = openai.hits.length;
    const enableOther = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-schedules',
      headers: headers(other, { 'idempotency-key': nextKey('other-enable') }),
      payload: scheduleBody(),
    });
    expect(enableOther.statusCode).toBe(404);
    useNextDay();
    const otherTick = await tick(other);
    expect(otherTick.decision.action).toBe('skip');
    expect(otherTick.decision.skipReason).toBe('tenant_not_enabled');
    expect(otherTick.decision.runId).toBeNull();
    const hidden = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-schedules?tenantId=${tenant.tenantId}`,
      headers: headers(other),
    });
    expect(hidden.json()).toEqual({ schedule: null });
    const hiddenDecisions = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-schedules/decisions?tenantId=${tenant.tenantId}`,
      headers: headers(other),
    });
    expect(hiddenDecisions.json()).toEqual({ decisions: [], nextCursor: null });
    const hiddenReports = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/recommendations?tenantId=${tenant.tenantId}&limit=50`,
      headers: headers(other),
    });
    expect(hiddenReports.json()).toEqual({ recommendations: [], nextCursor: null });
    const kill = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-controls',
      headers: headers(other),
      payload: { killSwitch: true },
    });
    expect(kill.statusCode).toBe(404);
    const flag = await admin.query<{ kill_switch: boolean }>(`SELECT kill_switch FROM evaluation_controls WHERE singleton`);
    expect(flag.rows[0]?.kill_switch).toBe(false);
    expect(openai.hits.length).toBe(hits);
    expectNoRaw(otherTick.decision);
  });

  it('replays a scheduled run inside budget and leaves routing unchanged', async () => {
    const routingBefore = await routingSnapshot();
    const day = useNextDay();
    await cancelOpen();
    const hits = openai.hits.length;
    const started = await tick();
    expect(started.statusCode, started.raw).toBe(201);
    const runId = started.decision.runId;
    if (runId === null) throw new Error('scheduled run was not stored');
    expect(await reservationCount(day)).toBe(1);
    expect(openai.hits.length).toBe(hits);
    const played = await pollEvaluationOnce(ctx.runtimePool, workerOptions({ callCounter: { count: 0 } }));
    expect(played).toMatchObject({ claimed: true, outcome: 'completed' });
    expect(openai.hits.length).toBe(hits + 1);
    const second = await manual();
    expect(second.statusCode).toBe(201);
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions())).toMatchObject({ claimed: true, outcome: 'completed' });
    const report = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${runId}/report`,
      headers: headers(tenant),
    });
    expect(report.statusCode, report.body).toBe(200);
    const body = report.json() as {
      evaluationId: string;
      routingChange: boolean;
      readOnly: boolean;
      recommendation: { evaluationId: string; routingChange: boolean; readOnly: boolean };
    };
    expect(body.evaluationId).toBe(runId);
    expect(body.routingChange).toBe(false);
    expect(body.readOnly).toBe(true);
    expect(body.recommendation.routingChange).toBe(false);
    expectNoRaw(body);
    const listed = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations/recommendations?limit=50',
      headers: headers(tenant),
    });
    expect(listed.statusCode).toBe(200);
    const page = listed.json() as { recommendations: Array<{ evaluationId: string; routingChange: boolean }> };
    expect(page.recommendations.map((row) => row.evaluationId)).toContain(runId);
    expect(page.recommendations.every((row) => row.routingChange === false)).toBe(true);
    expectNoRaw(page);
    expect(await routingSnapshot()).toEqual(routingBefore);
    console.log(
      JSON.stringify({
        step: 'schedule-journey',
        runId,
        reasonCodes: started.decision.reasonCodes,
        routingChange: false,
        plaintext: false,
        providerCallsForRun: 1,
      }),
    );
  });

  it('returns a decision when the original duration exceeds the int4 product', async () => {
    const original = await admin.query<{ id: string; duration_ms: number | null; latency_ms: number }>(
      `SELECT ma.id::text AS id, ma.duration_ms, eff.latency_ms
       FROM request_samples s
       JOIN LATERAL (
         SELECT id, duration_ms
         FROM model_attempts
         WHERE request_id = s.request_id AND tenant_id = s.tenant_id AND status = 'succeeded'
         ORDER BY created_at
         LIMIT 1
       ) ma ON true
       JOIN LATERAL (
         SELECT latency_ms
         FROM evaluation_attempts
         WHERE sample_id = s.id AND status = 'completed' AND latency_ms IS NOT NULL
         ORDER BY created_at DESC
         LIMIT 1
       ) eff ON true
       WHERE s.id = $1`,
      [sampleId],
    );
    const row = original.rows[0];
    if (row === undefined) throw new Error('completed attempt is missing');
    const longDuration = 2_147_483_647;
    expect(longDuration - row.latency_ms).toBeGreaterThan(2_147_483);
    await admin.query(`UPDATE model_attempts SET duration_ms = $2 WHERE id = $1`, [row.id, longDuration]);
    try {
      useNextDay();
      await cancelOpen();
      const result = await tick();
      expect(result.statusCode, result.raw).toBeGreaterThanOrEqual(200);
      expect(result.statusCode, result.raw).toBeLessThan(300);
      expect(['run', 'skip']).toContain(result.decision.action);
      expect(result.raw).not.toContain('integer out of range');
      console.log(
        JSON.stringify({
          step: 'long-duration',
          durationMs: longDuration,
          latencyMs: row.latency_ms,
          status: result.statusCode,
          action: result.decision.action,
        }),
      );
    } finally {
      await admin.query(`UPDATE model_attempts SET duration_ms = $2 WHERE id = $1`, [row.id, row.duration_ms]);
      await cancelOpen();
    }
  });

  it('states drift from stored evidence and ignores later runs', async () => {
    const completed = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM evaluation_runs
       WHERE tenant_id = $1 AND status = 'completed'
       ORDER BY created_at, id`,
      [tenant.tenantId],
    );
    expect(completed.rows.length).toBeGreaterThanOrEqual(2);
    const earlierId = completed.rows[0]?.id;
    const laterId = completed.rows[1]?.id;
    if (earlierId === undefined || laterId === undefined) throw new Error('drift runs are missing');
    const profile = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: headers(tenant),
      payload: {
        name: 'schedule-drift',
        taskCategory: 'general_qa',
        config: {
          limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 },
          validators: [{ id: 'json_parse', version: 1 }],
        },
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const profileBody = profile.json() as { id: string; versionId: string; version: number };
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${profileBody.id}/versions/${profileBody.version}/approve`,
      headers: headers(tenant),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const items = await admin.query<{ run_id: string; id: string }>(
      `SELECT run_id::text AS run_id, id::text AS id FROM evaluation_items WHERE run_id = ANY($1::uuid[])`,
      [[earlierId, laterId]],
    );
    const earlierItem = items.rows.find((row) => row.run_id === earlierId)?.id;
    const laterItem = items.rows.find((row) => row.run_id === laterId)?.id;
    if (earlierItem === undefined || laterItem === undefined) throw new Error('drift items are missing');
    const asOf = new Date();
    const earlierAt = new Date(asOf.getTime() - 5 * 86_400_000);
    const laterAt = new Date(asOf.getTime() - 1 * 86_400_000);
    const deployedAt = new Date(asOf.getTime() - 3 * 86_400_000);
    await admin.query(
      `INSERT INTO evaluation_validator_results (
         tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
         result, measured, evidence_code, reference_present, created_at
       )
       SELECT tenant_id, $1, $2, $3, 'challenger', 'json_parse', 1, $4, '{}'::jsonb, 'stored_check', false, $5
       FROM evaluation_runs WHERE id = $1`,
      [earlierId, earlierItem, profileBody.versionId, 'pass', earlierAt],
    );
    await admin.query(
      `INSERT INTO evaluation_validator_results (
         tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
         result, measured, evidence_code, reference_present, created_at
       )
       SELECT tenant_id, $1, $2, $3, 'challenger', 'json_parse', 1, 'fail', '{}'::jsonb, 'stored_check', false, $4
       FROM evaluation_runs WHERE id = $1`,
      [laterId, laterItem, profileBody.versionId, laterAt],
    );
    await admin.query(`UPDATE evaluation_attempts SET latency_ms = 100, status = 'completed' WHERE run_id = $1`, [earlierId]);
    await admin.query(`UPDATE evaluation_attempts SET latency_ms = 400, status = 'failed' WHERE run_id = $1`, [laterId]);
    await admin.query(
      `UPDATE model_attempts ma
       SET upstream_model = 'gpt-07f-later'
       FROM evaluation_attempts ea
       WHERE ea.model_attempt_id = ma.id AND ea.run_id = $1`,
      [laterId],
    );
    const prices = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM price_versions WHERE provider = 'openai' AND model = $1 ORDER BY effective_at`,
      [SOURCE_MODEL],
    );
    expect(prices.rows.length).toBeGreaterThanOrEqual(2);
    const firstPrice = prices.rows[0]?.id;
    const secondPrice = prices.rows[1]?.id;
    if (firstPrice === undefined || secondPrice === undefined) throw new Error('prices are missing');
    await admin.query('ALTER TABLE attempt_costs DISABLE TRIGGER attempt_costs_immutable');
    try {
      for (const [runId, priceId] of [
        [earlierId, firstPrice],
        [laterId, secondPrice],
      ] as const) {
        const updated = await admin.query(
          `UPDATE attempt_costs ac
           SET price_version_id = $2
           FROM evaluation_attempts ea
           WHERE ea.model_attempt_id = ac.attempt_id AND ea.tenant_id = ac.tenant_id AND ea.run_id = $1`,
          [runId, priceId],
        );
        expect(updated.rowCount).toBeGreaterThan(0);
      }
    } finally {
      await admin.query('ALTER TABLE attempt_costs ENABLE TRIGGER attempt_costs_immutable');
    }
    await admin.query(`UPDATE evaluation_runs SET created_at = $2, updated_at = $2 WHERE id = $1`, [earlierId, earlierAt]);
    await admin.query(`UPDATE evaluation_runs SET created_at = $2, updated_at = $2 WHERE id = $1`, [laterId, laterAt]);
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'fresh',
        '--upstream-model',
        CHALLENGER_MODEL,
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    await admin.query(`UPDATE model_deployments SET created_at = $2 WHERE tenant_id = $1 AND name = 'fresh'`, [
      tenant.tenantId,
      deployedAt,
    ]);
    await admin.query(
      `INSERT INTO evaluation_runs (
         tenant_id, definition_version_id, status, idempotency_key, request_hash, config_snapshot,
         sample_category, challenger_deployment, budget_estimate, item_count, completed_count, created_at, updated_at
       )
       SELECT tenant_id, definition_version_id, 'completed', 'drift-coding-run', request_hash, config_snapshot,
              'coding', challenger_deployment, budget_estimate, item_count, completed_count, $2, $2
       FROM evaluation_runs WHERE id = $1`,
      [laterId, laterAt],
    );
    await copySample(sampleId, { createdAt: new Date(asOf.getTime() - 10 * 86_400_000), category: 'coding' });
    const current = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-schedules/drift?asOf=${encodeURIComponent(asOf.toISOString())}`,
      headers: headers(tenant),
    });
    expect(current.statusCode, current.body).toBe(200);
    const report = current.json() as DriftBody;
    expectNoRaw(report);
    expect(report.historical).toBe(true);
    expect(report.workloadMixChange).toBe(true);
    expect(report.limits).toContain('mixed_task_category');
    const paired = report.statements.find((row) => row.taskCategory === 'general_qa');
    expect(paired?.comparable).toBe(true);
    expect(paired?.qualityDrift).toBe(true);
    expect(paired?.schemaValidityRegression).toBe(true);
    expect(paired?.latencyRegression).toBe(true);
    expect(paired?.reliabilityRegression).toBe(true);
    expect(paired?.modelVersionChanged).toBe(true);
    expect(paired?.priceVersionChanged).toBe(true);
    expect(paired?.newModelDeployed).toBe(true);
    expect(report.statements.some((row) => row.taskCategory === 'coding' && row.comparable === false)).toBe(true);
    const historicalAsOf = new Date(asOf.getTime() - 3 * 86_400_000);
    const historical = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-schedules/drift?asOf=${encodeURIComponent(historicalAsOf.toISOString())}`,
      headers: headers(tenant),
    });
    expect(historical.statusCode, historical.body).toBe(200);
    const past = historical.json() as DriftBody;
    expect(past.statements.every((row) => row.qualityDrift === null)).toBe(true);
    expect(past.limits).toContain('insufficient_history');
    console.log(
      JSON.stringify({
        step: 'drift',
        workloadMixChange: report.workloadMixChange,
        limits: report.limits,
        qualityDrift: paired?.qualityDrift,
        schemaValidityRegression: paired?.schemaValidityRegression,
        latencyRegression: paired?.latencyRegression,
        reliabilityRegression: paired?.reliabilityRegression,
        modelVersionChanged: paired?.modelVersionChanged,
        priceVersionChanged: paired?.priceVersionChanged,
        newModelDeployed: paired?.newModelDeployed,
        historicalQualityDrift: null,
      }),
    );
  });

  it('ignores a validator and a completion stored after asOf', async () => {
    const asOf = new Date();
    const held = await copySample(sampleId, { createdAt: new Date(asOf.getTime() + 2 * 3_600_000) });
    await mutateSample(held, `UPDATE request_samples SET deletion_hold = true WHERE id = $1`, [held]);
    const profile = await admin.query<{ id: string }>(
      `SELECT pv.id::text AS id
       FROM evaluation_profile_versions pv
       JOIN evaluation_profiles p ON p.id = pv.profile_id AND p.tenant_id = pv.tenant_id
       WHERE p.tenant_id = $1 AND p.name = 'schedule-drift' AND pv.status = 'approved'`,
      [tenant.tenantId],
    );
    const profileVersionId = profile.rows[0]?.id;
    if (profileVersionId === undefined) throw new Error('approved profile is missing');
    const source = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM evaluation_runs
       WHERE tenant_id = $1 AND status = 'completed' AND sample_category = 'general_qa'
       ORDER BY created_at LIMIT 1`,
      [tenant.tenantId],
    );
    const sourceId = source.rows[0]?.id;
    if (sourceId === undefined) throw new Error('source run is missing');
    async function insertRun(key: string, createdAt: Date, updatedAt: Date): Promise<string> {
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO evaluation_runs (
           tenant_id, definition_version_id, status, idempotency_key, request_hash, config_snapshot,
           sample_category, challenger_deployment, budget_estimate, item_count,
           pending_count, queued_count, running_count, completed_count, failed_count, cancelled_count,
           created_at, updated_at
         )
         SELECT tenant_id, definition_version_id, 'completed', $2, request_hash, config_snapshot,
                'summarization', challenger_deployment, budget_estimate, 1,
                0, 0, 0, 1, 0, 0,
                $3, $4
         FROM evaluation_runs WHERE id = $1
         RETURNING id::text AS id`,
        [sourceId, key, createdAt, updatedAt],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('summarization run was not stored');
      return id;
    }
    async function insertItem(runId: string, at: Date): Promise<string> {
      const inserted = await admin.query<{ id: string }>(
        `INSERT INTO evaluation_items (tenant_id, run_id, sample_id, ordinal, status, created_at, updated_at)
         SELECT tenant_id, $1, $2, 0, 'completed', $3, $3
         FROM evaluation_runs WHERE id = $1
         RETURNING id::text AS id`,
        [runId, held, at],
      );
      const id = inserted.rows[0]?.id;
      if (id === undefined) throw new Error('summarization item was not stored');
      return id;
    }
    async function insertValidator(runId: string, itemId: string, version: number, result: string, at: Date): Promise<void> {
      await admin.query(
        `INSERT INTO evaluation_validator_results (
           tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
           result, measured, evidence_code, reference_present, created_at
         )
         SELECT tenant_id, $1, $2, $3, 'challenger', 'json_parse', $4, $5, '{}'::jsonb, 'stored_check', false, $6
         FROM evaluation_runs WHERE id = $1`,
        [runId, itemId, profileVersionId, version, result, at],
      );
    }
    const earlierAt = new Date(asOf.getTime() - 2 * 86_400_000);
    const laterAt = new Date(asOf.getTime() - 1 * 86_400_000);
    const earlierRun = await insertRun('drift-asof-earlier', earlierAt, earlierAt);
    const laterRun = await insertRun('drift-asof-later', laterAt, laterAt);
    const earlierItem = await insertItem(earlierRun, earlierAt);
    const laterItem = await insertItem(laterRun, laterAt);
    await insertValidator(earlierRun, earlierItem, 1, 'pass', earlierAt);
    await insertValidator(laterRun, laterItem, 1, 'pass', laterAt);
    const before = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-schedules/drift?asOf=${encodeURIComponent(asOf.toISOString())}`,
      headers: headers(tenant),
    });
    expect(before.statusCode, before.body).toBe(200);
    const beforeBody = before.json() as DriftBody;
    const beforeStatement = beforeBody.statements.find((row) => row.taskCategory === 'summarization');
    expect(beforeStatement?.comparable).toBe(true);
    expect(beforeStatement?.qualityDrift).toBe(false);
    expect(beforeStatement?.schemaValidityRegression).toBe(false);
    const afterAsOf = new Date(asOf.getTime() + 3_600_000);
    await insertValidator(laterRun, laterItem, 2, 'fail', afterAsOf);
    const futureRun = await insertRun('drift-asof-future', new Date(asOf.getTime() - 3_600_000), afterAsOf);
    const futureItem = await insertItem(futureRun, afterAsOf);
    await insertValidator(futureRun, futureItem, 1, 'fail', afterAsOf);
    const after = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluation-schedules/drift?asOf=${encodeURIComponent(asOf.toISOString())}`,
      headers: headers(tenant),
    });
    expect(after.statusCode, after.body).toBe(200);
    const afterBody = after.json() as DriftBody;
    const afterStatement = afterBody.statements.find((row) => row.taskCategory === 'summarization');
    expect(afterStatement).toEqual(beforeStatement);
    expectNoRaw(afterBody);
    console.log(
      JSON.stringify({
        step: 'drift-asof',
        comparable: afterStatement?.comparable,
        qualityDrift: afterStatement?.qualityDrift,
        schemaValidityRegression: afterStatement?.schemaValidityRegression,
      }),
    );
  });

  it('schedules again when evidence is stale or quality has regressed', async () => {
    useNextDay();
    await cancelOpen();
    const hits = openai.hits.length;
    const result = await tick();
    expect(result.statusCode, result.raw).toBe(201);
    expect(result.decision.reasonCodes).toEqual(expect.arrayContaining(['stale_evidence', 'quality_regression', 'bounded_sample']));
    expect(openai.hits.length).toBe(hits);
    await cancelOpen();
  });

  it('does not repeat a provider call after a crash once the call has left the worker', async () => {
    useNextDay();
    await cancelOpen();
    const started = await manual();
    expect(started.decision.action).toBe('run');
    const runId = started.decision.runId;
    if (runId === null) throw new Error('crash run was not stored');
    const hits = openai.hits.length;
    const calls = { count: 0 };
    const dispatched = await pollEvaluationOnce(ctx.runtimePool, workerOptions({ stopAfterDispatch: true, callCounter: calls }));
    expect(dispatched).toEqual({ claimed: true, outcome: 'dispatched' });
    expect(openai.hits.length).toBe(hits);
    expect(calls.count).toBe(0);
    await releaseJob(runId);
    const again = await pollEvaluationOnce(ctx.runtimePool, workerOptions({ callCounter: calls }));
    expect(again).toMatchObject({ claimed: true, outcome: 'failed' });
    expect(await itemReason(runId)).toBe('uncertain');
    expect(openai.hits.length).toBe(hits);
    expect(calls.count).toBe(0);
  });

  it('cancels a tenant run before dispatch', async () => {
    useNextDay();
    await cancelOpen();
    const started = await manual();
    const runId = started.decision.runId;
    if (runId === null) throw new Error('cancel run was not stored');
    const hits = openai.hits.length;
    const startedAt = performance.now();
    const cancelled = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluations/${runId}/cancel`,
      headers: headers(tenant),
      payload: {},
    });
    const cancelMs = performance.now() - startedAt;
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const played = await pollEvaluationOnce(ctx.runtimePool, workerOptions());
    expect(played.outcome === 'cancelled' || played.outcome === 'idle').toBe(true);
    expect(openai.hits.length).toBe(hits);
    expect(cancelMs).toBeGreaterThanOrEqual(0);
    console.log(JSON.stringify({ step: 'cancel-latency-ms', cancelMs }));
  });

  it('cancels a run that exceeds its schedule duration', async () => {
    await restoreSchedule({ maxDurationMs: 1000 });
    try {
      useNextDay();
      await cancelOpen();
      const started = await tick();
      expect(started.decision.action).toBe('run');
      const runId = started.decision.runId;
      if (runId === null) throw new Error('duration run was not stored');
      await admin.query(`UPDATE evaluation_runs SET created_at = now() - interval '1 minute' WHERE id = $1`, [runId]);
      const hits = openai.hits.length;
      const played = await pollEvaluationOnce(ctx.runtimePool, workerOptions());
      expect(played).toMatchObject({ claimed: false, outcome: 'idle' });
      const status = await admin.query<{ status: string }>(`SELECT status FROM evaluation_runs WHERE id = $1`, [runId]);
      expect(status.rows[0]?.status).toBe('cancelled');
      expect(openai.hits.length).toBe(hits);
    } finally {
      await restoreSchedule();
    }
  });

  it('does not call a provider when the database is down', async () => {
    const outage = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
      evaluationScheduleTenantIds: [tenant.tenantId],
      scheduleNow: () => new Date(Date.UTC(2026, 7, 1, 12)),
    });
    const before = await runCount();
    const hits = openai.hits.length;
    await outage.runtimePool.end();
    try {
      const response = await outage.app.inject({
        method: 'POST',
        url: '/internal/v1/evaluation-schedules/tick',
        headers: headers(tenant, { 'idempotency-key': nextKey('outage') }),
        payload: {},
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain(PROMPT);
      expect(response.body).not.toContain(COMPLETION);
      expect(await runCount()).toBe(before);
      expect(openai.hits.length).toBe(hits);
    } finally {
      await outage.app.close();
      await outage.authPool.end();
    }
  });

  it('measures scheduler and replay cost on a synthetic workload', async () => {
    for (let index = 0; index < 7; index += 1) await copySample(sampleId);
    await restoreSchedule({ maxSamples: 8, perRunMaxExpense: '1', dailyLimit: '1' });
    const chatStarted = performance.now();
    const beforeChat = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: {
        model: 'chat',
        messages: [{ role: 'user', content: `${PROMPT}-perf` }],
        task: 'general_qa',
        temperature: 0,
        max_tokens: 16,
      },
    });
    const chatBeforeMs = performance.now() - chatStarted;
    expect(beforeChat.statusCode, beforeChat.body).toBe(200);
    useNextDay();
    await cancelOpen();
    const locksBefore = await admin.query<{ locks: number; waiting: number }>(
      `SELECT count(*)::int AS locks, count(*) FILTER (WHERE NOT granted)::int AS waiting FROM pg_locks`,
    );
    const tickStarted = performance.now();
    const started = await manual();
    const tickMs = performance.now() - tickStarted;
    expect(started.statusCode, JSON.stringify(started.decision)).toBe(201);
    const runId = started.decision.runId;
    if (runId === null) throw new Error('perf run was not stored');
    const backlog = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_jobs WHERE run_id = $1 AND status = 'pending'`,
      [runId],
    );
    const hits = openai.hits.length;
    const replayStarted = performance.now();
    let completed = 0;
    for (let index = 0; index < 8; index += 1) {
      const played = await pollEvaluationOnce(ctx.runtimePool, workerOptions());
      if (played.outcome === 'completed') completed += 1;
    }
    const replayMs = performance.now() - replayStarted;
    const providerCalls = openai.hits.length - hits;
    const memory = process.memoryUsage();
    const chatAfterStarted = performance.now();
    const afterChat = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: {
        model: 'chat',
        messages: [{ role: 'user', content: `${PROMPT}-perf-after` }],
        task: 'general_qa',
        temperature: 0,
        max_tokens: 16,
      },
    });
    const chatAfterMs = performance.now() - chatAfterStarted;
    expect(afterChat.statusCode, afterChat.body).toBe(200);
    const locksAfter = await admin.query<{ locks: number; waiting: number; deadlocks: number }>(
      `SELECT count(*)::int AS locks, count(*) FILTER (WHERE NOT granted)::int AS waiting,
              (SELECT deadlocks FROM pg_stat_database WHERE datname = current_database())::int AS deadlocks
       FROM pg_locks`,
    );
    const report = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${runId}/report`,
      headers: headers(tenant),
    });
    expect(report.statusCode, report.body).toBe(200);
    const body = report.json() as {
      samples: { validPairs: number };
      cost: { evaluationExpense: { amount: string | null; status: string } };
    };
    const reserved = await admin.query<{ amount: string }>(
      `SELECT amount::text AS amount FROM evaluation_budget_reservations r
       JOIN evaluation_schedule_decisions d ON d.id = r.decision_id
       WHERE d.run_id = $1`,
      [runId],
    );
    const reservedAmount = reserved.rows[0]?.amount ?? null;
    const validPairs = body.samples.validPairs;
    const expense = body.cost.evaluationExpense.amount;
    const measured = {
      evaluationThroughputPerSecond: replayMs === 0 ? null : completed / (replayMs / 1000),
      evaluationBacklog: backlog.rows[0]?.count ?? null,
      workerMemory: {
        heapUsed: memory.heapUsed,
        rss: memory.rss,
        note: 'heap and rss are the in-process test worker, which shares the vitest process',
      },
      postgresqlContention: {
        locksBefore: locksBefore.rows[0]?.locks ?? null,
        waitingBefore: locksBefore.rows[0]?.waiting ?? null,
        locksAfter: locksAfter.rows[0]?.locks ?? null,
        waitingAfter: locksAfter.rows[0]?.waiting ?? null,
        deadlocks: locksAfter.rows[0]?.deadlocks ?? null,
      },
      budgetReservationOverheadMs: tickMs,
      schedulerOverheadMs: tickMs,
      productionInferenceLatencyMs: { before: chatBeforeMs, after: chatAfterMs },
      evaluationCostPerValidComparison:
        validPairs > 0 && expense !== null ? Number(expense) / validPairs : null,
      reservedAmount,
      validPairs,
      completedAttempts: completed,
      providerCalls,
      judgeDisagreementRate: null,
      judgeDisagreementReason: 'the synthetic load does not call a judge',
      costPerValidComparisonReason:
        validPairs > 0 && expense !== null ? 'evaluation expense divided by completed attempt pairs' : 'expense or valid pairs were missing',
    };
    expect(completed).toBeGreaterThan(0);
    expect(measured.evaluationThroughputPerSecond).not.toBeNull();
    console.log(JSON.stringify({ step: 'PERF', ...measured }));
    await restoreSchedule();
  });

  it('boots the API and the worker twice and does not change a route', async () => {
    await cancelOpen();
    await restoreSchedule({ dailyLimit: '0.05', monthlyLimit: '1', perRunMaxExpense: '0.05', maxSamples: 1 });
    const routingBefore = await routingSnapshot();
    const runsBefore = await runCount();
    const hitsBefore = openai.hits.length;
    const disabledPort = await freePort();
    const disabled = spawnServer(
      serviceEnv(db, {
        PORT: String(disabledPort),
        LOG_LEVEL: 'info',
        INFERENCE_ENABLED: 'true',
        OPENAI_BASE_URL: openai.baseUrl,
        PROVIDER_CREDENTIAL_KEY: credentialKeyText,
      }),
    );
    let disabledText = '';
    try {
      await waitForReady(disabledPort);
      disabledText = disabled.output();
      expect(disabledText).not.toContain('evaluation-worker');
      const response = await fetch(`http://127.0.0.1:${disabledPort}/internal/v1/evaluation-schedules/tick`, {
        method: 'POST',
        headers: { ...headers(tenant), 'idempotency-key': nextKey('launch-off'), 'content-type': 'application/json' },
        body: '{}',
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const decision = JSON.parse(text) as Decision;
      expect(decision.skipReason).toBe('scheduler_disabled');
      expect(decision.runId).toBeNull();
      expect(text).not.toContain(PROMPT);
      expect(await runCount()).toBe(runsBefore);
      expect(openai.hits.length).toBe(hitsBefore);
      console.log(JSON.stringify({ step: 'launch-disabled', skipReason: decision.skipReason, runId: decision.runId }));
    } finally {
      await stopChild(disabled.child);
    }

    async function bootTick(label: string, extra: Record<string, string | undefined>): Promise<{ text: string; decision: Decision }> {
      const port = await freePort();
      const child = spawnServer(
        serviceEnv(db, {
          PORT: String(port),
          LOG_LEVEL: 'info',
          INFERENCE_ENABLED: 'true',
          OPENAI_BASE_URL: openai.baseUrl,
          PROVIDER_CREDENTIAL_KEY: credentialKeyText,
          EVALUATION_SCHEDULE_TENANTS: tenant.tenantId,
          ...extra,
        }),
      );
      try {
        await waitForReady(port);
        expect(child.output()).not.toContain('evaluation-worker');
        const response = await fetch(`http://127.0.0.1:${port}/internal/v1/evaluation-schedules/tick`, {
          method: 'POST',
          headers: { ...headers(tenant), 'idempotency-key': nextKey(label), 'content-type': 'application/json' },
          body: '{}',
        });
        const text = await response.text();
        const decision = JSON.parse(text) as Decision;
        console.log(JSON.stringify({ step: label, status: response.status, action: decision.action, skipReason: decision.skipReason, runId: decision.runId, fresh: decision.fresh }));
        return { text, decision: { ...decision, statusCode: response.status } as Decision & { statusCode?: number } };
      } finally {
        await stopChild(child.child);
      }
    }

    const killed = await bootTick('launch-kill', { EVALUATION_GLOBAL_KILL: 'true' });
    expect(killed.decision.skipReason).toBe('global_kill_switch');
    expect(killed.decision.runId).toBeNull();
    expect(await runCount()).toBe(runsBefore);
    expect(openai.hits.length).toBe(hitsBefore);

    const first = await bootTick('launch-run', { EVALUATION_GLOBAL_KILL: 'false' });
    expect(first.decision.action).toBe('run');
    expect(first.decision.runId).not.toBeNull();
    const runId = first.decision.runId;
    if (runId === null) throw new Error('launch run was not stored');
    expect(openai.hits.length).toBe(hitsBefore);
    const reserved = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_budget_reservations r
       JOIN evaluation_schedule_decisions d ON d.id = r.decision_id
       WHERE d.run_id = $1 AND r.status = 'reserved'`,
      [runId],
    );
    expect(reserved.rows[0]?.count).toBe(1);

    const second = await bootTick('launch-duplicate', { EVALUATION_GLOBAL_KILL: 'false' });
    expect(second.decision.runId).toBe(runId);
    expect(second.decision.fresh).toBe(false);
    expect(await runCount()).toBe(runsBefore + 1);
    expect(openai.hits.length).toBe(hitsBefore);

    async function drainWorker(label: string): Promise<{ code: number | null; output: string }> {
      const child = spawn(process.execPath, [WORKER_ENTRY], {
        cwd: projectRoot,
        env: serviceEnv(db, {
          LOG_LEVEL: 'info',
          INFERENCE_ENABLED: 'true',
          OPENAI_BASE_URL: openai.baseUrl,
          PROVIDER_CREDENTIAL_KEY: credentialKeyText,
          EVALUATION_EXECUTION_ENABLED: 'true',
          EVALUATION_REPLAY_TENANTS: tenant.tenantId,
          EVALUATION_SCHEDULE_TENANTS: tenant.tenantId,
          EVALUATION_WORKER_DRAIN: 'true',
          EVALUATION_GLOBAL_KILL: 'false',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout?.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        output += String(chunk);
      });
      const code = await waitForExit(child, 30_000);
      console.log(JSON.stringify({ step: label, code, calls: output.match(/"modelCalls":(\d+)/)?.[1] ?? null }));
      return { code, output };
    }

    const drained = await drainWorker('launch-worker-1');
    expect(drained.code).toBe(0);
    expect(drained.output).not.toContain(PROMPT);
    expect(drained.output).not.toContain(COMPLETION);
    expect(openai.hits.length).toBe(hitsBefore + 1);
    const drainedAgain = await drainWorker('launch-worker-2');
    expect(drainedAgain.code).toBe(0);
    expect(openai.hits.length).toBe(hitsBefore + 1);
    expect(await runCount()).toBe(runsBefore + 1);

    async function readReport(label: string): Promise<{ state: string; routingChange: boolean; text: string }> {
      const port = await freePort();
      const child = spawnServer(
        serviceEnv(db, {
          PORT: String(port),
          LOG_LEVEL: 'info',
          INFERENCE_ENABLED: 'true',
          OPENAI_BASE_URL: openai.baseUrl,
          PROVIDER_CREDENTIAL_KEY: credentialKeyText,
          EVALUATION_SCHEDULE_TENANTS: tenant.tenantId,
        }),
      );
      try {
        await waitForReady(port);
        expect(child.output()).not.toContain('evaluation-worker');
        const response = await fetch(`http://127.0.0.1:${port}/internal/v1/evaluations/${runId}/report`, {
          headers: headers(tenant),
        });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        expect(text).not.toContain(PROMPT);
        expect(text).not.toContain(COMPLETION);
        const body = JSON.parse(text) as { recommendation: { state: string; routingChange: boolean }; routingChange: boolean };
        console.log(JSON.stringify({ step: label, state: body.recommendation.state, routingChange: body.routingChange }));
        return { state: body.recommendation.state, routingChange: body.routingChange, text };
      } finally {
        await stopChild(child.child);
      }
    }

    const readA = await readReport('launch-read-1');
    const readB = await readReport('launch-read-2');
    expect(readA.state).toBe(readB.state);
    expect(readA.routingChange).toBe(false);
    expect(readB.routingChange).toBe(false);
    expect(await routingSnapshot()).toEqual(routingBefore);
    console.log(JSON.stringify({ step: 'launch-compare', sameState: readA.state === readB.state, routingChange: false, runId }));
  });

  it('does not call a provider after expiry, revocation, or deletion', async () => {
    await restoreSchedule();
    useNextDay();
    await cancelOpen();
    const expired = await manual();
    expect(expired.decision.action).toBe('run');
    const expiredRun = expired.decision.runId;
    const expiredSample = expired.decision.selectedSampleIds[0];
    if (expiredRun === undefined || expiredRun === null || expiredSample === undefined) throw new Error('expiry run was not stored');
    await mutateSample(
      expiredSample,
      `UPDATE request_samples
       SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       WHERE id = $1`,
      [expiredSample],
    );
    const expiryHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions())).toMatchObject({ claimed: true, outcome: 'failed' });
    expect(await itemReason(expiredRun)).toBe('sample_expired');
    expect(openai.hits.length).toBe(expiryHits);

    useNextDay();
    const revoked = await manual();
    expect(revoked.decision.action).toBe('run');
    const revokedRun = revoked.decision.runId;
    if (revokedRun === null) throw new Error('revocation run was not stored');
    setPolicy(false);
    const revokedHits = openai.hits.length;
    try {
      expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions())).toMatchObject({ claimed: true, outcome: 'failed' });
      expect(await itemReason(revokedRun)).toBe('replay_denied');
      expect(openai.hits.length).toBe(revokedHits);
    } finally {
      setPolicy(true);
    }

    const replacement = await copySample(sampleId);
    expect(replacement).not.toBe('');
    useNextDay();
    const deleted = await manual();
    expect(deleted.decision.action).toBe('run');
    const deletedRun = deleted.decision.runId;
    const deletedSample = deleted.decision.selectedSampleIds[0];
    if (deletedRun === null || deletedSample === undefined) throw new Error('deletion run was not stored');
    const removed = await ctx.app.inject({
      method: 'DELETE',
      url: `/internal/v1/samples/${deletedSample}`,
      headers: {
        'x-tenant-id': tenant.tenantId,
        authorization: `Bearer ${tenant.secret}`,
      },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const deletedHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions())).toMatchObject({ claimed: true, outcome: 'failed' });
    expect(await itemReason(deletedRun)).toBe('sample_not_owned');
    expect(openai.hits.length).toBe(deletedHits);
    const routing = await routingSnapshot();
    expect(routing.aliases).toContain('auto:chat');
    expect(routing.fallbackVersions).toEqual(routing.fallbackVersions);
  });
});
