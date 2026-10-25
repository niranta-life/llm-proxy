import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { guardUpstream } from '../src/db/breaker.js';
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
import { captureLogger, createTestApp, loadTestDatabase, projectRoot, runCli } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant } from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const PROMPT = 'eval-slice-07b-prompt-token';
const COMPLETION = 'eval-slice-07b-completion-token';
const SOURCE_MODEL = 'gpt-07b-source';
const CHALLENGER_MODEL = 'gpt-07b-challenger';
const UNPRICED_MODEL = 'gpt-07b-unpriced';
const EFFECTIVE = '2025-12-01T00:00:00.000Z';

type Tenant = { tenantId: string; secret: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;
type Mode = 'ok' | 'hang' | 'rate' | 'malformed' | 'nousage';

describe('challenger model replay', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;
  let mode: Mode = 'ok';
  const workerLogger = captureLogger();
  const credentialStore = createCredentialStore(credentialKey);
  const sampleKeyManager = createSampleKeyManager(credentialKey);

  beforeAll(async () => {
    openai = await startMockUpstream((hit, request, response) => {
      if (mode === 'hang') {
        request.on('aborted', () => {
          if (!response.destroyed) response.destroy();
        });
        return;
      }
      if (mode === 'rate') {
        response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
        response.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit_error' } }));
        return;
      }
      if (mode === 'malformed') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            id: 'x'.repeat(300),
            object: 'chat.completion',
            created: 1_700_000_000,
            model: CHALLENGER_MODEL,
            choices: [{ index: 0, message: { role: 'assistant', content: 'bad-output' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        );
        return;
      }
      const parsed = JSON.parse(hit.body) as { model?: string };
      const usage = mode === 'nousage' ? null : undefined;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(parsed.model ?? CHALLENGER_MODEL, COMPLETION, usage)));
    });
    admin = adminPool(db);
    ctx = await createTestApp(db, {
      inferenceEnabled: true,
      upstreamBaseUrl: openai.baseUrl,
      credentialKey,
    });
    runCli(
      db,
      [
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        CHALLENGER_MODEL,
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
    runCli(
      db,
      [
        'register-price',
        '--provider',
        'openai',
        '--upstream-model',
        SOURCE_MODEL,
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
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  function headers(tenant: Tenant, extra: Record<string, string> = {}): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
      ...extra,
    };
  }

  function errorCode(body: unknown): string | null {
    if (typeof body !== 'object' || body === null || !('error' in body)) return null;
    const error = (body as { error?: { code?: string | null } }).error;
    return error?.code ?? null;
  }

  function workerOptions(tenantId: string, extra: Partial<EvaluationWorkerOptions> = {}): EvaluationWorkerOptions {
    return {
      workerId: 'replay-worker',
      dryRun: false,
      executionEnabled: true,
      replayTenantIds: [tenantId],
      upstreamBaseUrl: openai.baseUrl,
      credentialStore,
      sampleKeyManager,
      logger: workerLogger.logger,
      ...extra,
    };
  }

  async function prepare(
    label: string,
    options: { challengerModel?: string; budget?: { mode: string; amount: string } | null } = {},
  ): Promise<{ tenant: Tenant; sampleId: string }> {
    const tenant = provisionTenant(db, label);
    const challengerModel = options.challengerModel ?? CHALLENGER_MODEL;
    runCli(
      db,
      ['register-openai-connection', '--tenant-id', tenant.tenantId, '--api-key', 'sk-test-eval-07b'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'chat',
        '--upstream-model',
        SOURCE_MODEL,
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    runCli(db, ['set-alias', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--deployment', 'chat'], cliEnv());
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        tenant.tenantId,
        '--name',
        'challenger',
        '--upstream-model',
        challengerModel,
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    setPolicy(tenant.tenantId, { deployments: 'chat,challenger', replay: 'true' });
    const response = await ctx.app.inject({
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
    expect(response.statusCode).toBe(200);
    const stored = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    const sampleId = stored.rows[0]?.id;
    if (sampleId === undefined) throw new Error('sample was not stored');
    if (options.budget !== null) {
      const budget = options.budget ?? { mode: 'hard', amount: '10' };
      runCli(
        db,
        ['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', budget.mode, '--monthly-amount', budget.amount],
        cliEnv(),
      );
    }
    return { tenant, sampleId };
  }

  function setPolicy(tenantId: string, options: { deployments?: string; replay?: string } = {}): void {
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
        options.deployments ?? 'chat,challenger',
      ],
      cliEnv(),
    );
  }

  async function copySample(
    sampleId: string,
    patch: {
      expired?: boolean;
      sourceLocation?: string | null;
      corrupt?: boolean;
      envelope?: EncryptedEnvelope;
      id?: string;
    } = {},
  ): Promise<string> {
    const source = await admin.query<Record<string, unknown>>(
      `SELECT request_id, tenant_id, policy_id, policy_version, provider, deployment_name, data_classification,
              schema_version, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
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
    let envelope = patch.envelope;
    let sealedId = patch.id ?? null;
    if (envelope === undefined && patch.corrupt !== true) {
      const opened = await loadSampleEnvelope(sampleId);
      const payload = decryptSample(
        sampleKeyManager,
        { tenantId: String(row.tenant_id), sampleId, schemaVersion: opened.schema_version },
        opened,
      );
      if (payload === null) throw new Error('sample did not open');
      sealedId = patch.id ?? randomUUID();
      const sealed = encryptSample(sampleKeyManager, {
        tenantId: String(row.tenant_id),
        sampleId: sealedId,
        schemaVersion: SAMPLE_SCHEMA_VERSION,
        payload,
      });
      if (sealed === null) throw new Error('sample was not sealed');
      envelope = sealed;
    }
    let content = bufferFrom(envelope?.contentCiphertext ?? row.content_ciphertext);
    if (patch.corrupt) content[content.length - 1] = (content[content.length - 1] ?? 0) ^ 0xff;
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO request_samples (
         id, tenant_id, request_id, policy_id, policy_version, provider, deployment_name,
         data_classification, schema_version, size_bytes, wrapping_key_version,
         wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
         content_iv, content_tag, content_ciphertext, created_at, expires_at,
         fingerprint, slot, task_category, input_size, complexity,
         exchange_complete, text_only, required_capabilities, source_location
       ) VALUES (
         COALESCE($26::uuid, gen_random_uuid()), $1, $2, $3, $4, $5, $6,
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
        envelope?.schemaVersion ?? row.schema_version,
        content.length,
        envelope?.wrappingKeyVersion ?? row.wrapping_key_version,
        envelope?.wrappedKeyIv ?? row.wrapped_key_iv,
        envelope?.wrappedKeyTag ?? row.wrapped_key_tag,
        envelope?.wrappedKeyCiphertext ?? row.wrapped_key_ciphertext,
        envelope?.contentIv ?? row.content_iv,
        envelope?.contentTag ?? row.content_tag,
        content,
        createdAt,
        expiresAt,
        row.slot,
        row.task_category,
        row.input_size,
        row.complexity,
        row.text_only,
        row.required_capabilities,
        patch.sourceLocation === undefined ? row.source_location : patch.sourceLocation,
        sealedId,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('clone was not stored');
    return id;
  }

  async function sealToolsSample(tenantId: string, sampleId: string): Promise<string> {
    const row = await loadSampleEnvelope(sampleId);
    const payload = decryptSample(sampleKeyManager, { tenantId, sampleId, schemaVersion: row.schema_version }, row);
    if (typeof payload !== 'object' || payload === null || !('request' in payload)) throw new Error('sample payload is invalid');
    const request = (payload as { request: Record<string, unknown> }).request;
    request.tools = [{ type: 'function', function: { name: 'lookup' } }];
    const id = randomUUID();
    const envelope = encryptSample(sampleKeyManager, {
      tenantId,
      sampleId: id,
      schemaVersion: SAMPLE_SCHEMA_VERSION,
      payload,
    });
    if (envelope === null) throw new Error('sample was not sealed');
    return copySample(sampleId, { id, envelope });
  }

  async function loadSampleEnvelope(sampleId: string): Promise<EncryptedEnvelope & { schema_version: number }> {
    const result = await admin.query<{
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
      [sampleId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('sample envelope is missing');
    return {
      schema_version: row.schema_version,
      schemaVersion: row.schema_version,
      wrappingKeyVersion: row.wrapping_key_version,
      wrappedKeyIv: bufferFrom(row.wrapped_key_iv),
      wrappedKeyTag: bufferFrom(row.wrapped_key_tag),
      wrappedKeyCiphertext: bufferFrom(row.wrapped_key_ciphertext),
      contentIv: bufferFrom(row.content_iv),
      contentTag: bufferFrom(row.content_tag),
      contentCiphertext: bufferFrom(row.content_ciphertext),
    };
  }

  async function createReplay(tenant: Tenant, sampleIds: string[], key: string): Promise<{ id: string; statusCode: number; body: unknown }> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(tenant, { 'idempotency-key': key }),
      payload: {
        name: 'weekly-replay',
        sampleCategory: 'general_qa',
        sampleIds,
        challengerDeployment: 'challenger',
        budgetEstimate: '0.25',
        mode: 'replay',
      },
    });
    const body: unknown = response.json();
    const id = typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string' ? body.id : '';
    return { id, statusCode: response.statusCode, body };
  }

  async function readItems(tenant: Tenant, evaluationId: string): Promise<{ statusCode: number; body: string; json: unknown }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${evaluationId}/items`,
      headers: headers(tenant),
    });
    return { statusCode: response.statusCode, body: response.body, json: response.json() };
  }

  async function evaluationCosts(tenantId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM attempt_costs c
       JOIN proxy_requests r ON r.tenant_id = c.tenant_id AND r.id = (
         SELECT request_id FROM model_attempts WHERE tenant_id = c.tenant_id AND id = c.attempt_id
       )
       WHERE c.tenant_id = $1 AND r.traffic_class = 'evaluation'`,
      [tenantId],
    );
    return result.rows[0]?.count ?? 0;
  }

  async function mutateSample(sampleId: string, sql: string, params: unknown[]): Promise<void> {
    await admin.query('ALTER TABLE request_samples DISABLE TRIGGER request_samples_immutable');
    try {
      await admin.query(sql, params);
    } finally {
      await admin.query('ALTER TABLE request_samples ENABLE TRIGGER request_samples_immutable');
    }
  }

  function enableChallengerBreaker(tenantId: string): void {
    runCli(
      db,
      [
        'set-deployment-breaker',
        '--tenant-id',
        tenantId,
        '--deployment',
        'challenger',
        '--enabled',
        'true',
        '--window-ms',
        '60000',
        '--min-samples',
        '2',
        '--failure-threshold',
        '2',
        '--cooldown-ms',
        '30000',
        '--max-probes',
        '1',
      ],
      cliEnv(),
    );
  }

  async function breakerSnap(tenantId: string): Promise<{
    deployment_id: string;
    state: string;
    state_reason: string;
    probes_inflight: number;
    state_changed_at: Date;
    cooldown_until: Date | null;
  }> {
    const result = await admin.query<{
      deployment_id: string;
      state: string;
      state_reason: string;
      probes_inflight: number;
      state_changed_at: Date;
      cooldown_until: Date | null;
    }>(
      `SELECT deployment_id::text AS deployment_id, state, state_reason, probes_inflight,
              state_changed_at, cooldown_until
       FROM deployment_breakers
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('breaker row is missing');
    return row;
  }

  function parsedHit(hit: MockHit): Record<string, unknown> {
    return JSON.parse(hit.body) as Record<string, unknown>;
  }

  it('keeps the replay path off the public proxy and off production routing', () => {
    const replay = readFileSync(`${projectRoot}/src/inference/replay-execution.ts`, 'utf8');
    const index = readFileSync(`${projectRoot}/src/index.ts`, 'utf8');
    const dockerfile = readFileSync(`${projectRoot}/Dockerfile`, 'utf8');
    expect(replay).not.toContain('resolveModel');
    expect(replay).not.toContain('executeChat');
    expect(replay).not.toContain("from './execute.js'");
    expect(replay).not.toContain('/v1/chat/completions');
    expect(replay).not.toContain('noteUpstream');
    expect(replay).not.toContain('guardUpstream');
    expect(replay).not.toContain('claimProbe');
    expect(index).not.toContain('evaluation-worker');
    expect(dockerfile).toContain('CMD ["node", "dist/index.js"]');
  });

  it('replays one approved sample on the pinned challenger and hides the output text', async () => {
    const { tenant, sampleId } = await prepare('Replay Authorized');
    const hitsBefore = openai.hits.length;
    workerLogger.lines.length = 0;
    const created = await createReplay(tenant, [sampleId], 'replay-authorized');
    expect(created.statusCode).toBe(201);
    expect(created.body).toMatchObject({ mode: 'replay', modelExecution: 'pinned', status: 'queued' });
    const polled = await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId));
    expect(polled).toEqual({ claimed: true, outcome: 'completed' });
    expect(openai.hits.length).toBe(hitsBefore + 1);
    const hit = openai.hits.at(-1);
    if (hit === undefined) throw new Error('mock request is missing');
    const providerRequest = parsedHit(hit);
    expect(providerRequest.model).toBe(CHALLENGER_MODEL);
    expect(providerRequest.temperature).toBe(0);
    expect(providerRequest.max_tokens).toBe(16);
    expect(providerRequest.stream).toBe(false);
    expect(providerRequest.tools).toBeUndefined();
    expect(providerRequest.function_call).toBeUndefined();
    expect(hit.url).toContain('/chat/completions');
    const items = await readItems(tenant, created.id);
    expect(items.statusCode).toBe(200);
    expect(items.json).toMatchObject({
      items: [
        {
          sampleId,
          status: 'completed',
          reasonCode: 'replay_completed',
          originalDeployment: 'chat',
          challengerDeployment: 'challenger',
          adapterVersion: 1,
          providerResponseId: 'chatcmpl-test',
          promptTokens: 3,
          completionTokens: 2,
          totalTokens: 5,
          costStatus: 'estimated',
        },
      ],
    });
    expect(items.body).not.toContain(PROMPT);
    expect(items.body).not.toContain(COMPLETION);
    expect(items.body).not.toContain('content_ciphertext');
    expect(workerLogger.lines.join('\n')).not.toContain(PROMPT);
    expect(workerLogger.lines.join('\n')).not.toContain(COMPLETION);
    const attempt = await admin.query<{
      id: string;
      schema_version: number;
      wrapping_key_version: number;
      wrapped_key_iv: Buffer;
      wrapped_key_tag: Buffer;
      wrapped_key_ciphertext: Buffer;
      content_iv: Buffer;
      content_tag: Buffer;
      content_ciphertext: Buffer;
      execution_parameters: string;
    }>(
      `SELECT id::text AS id, output_schema_version AS schema_version, wrapping_key_version,
              wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext, content_iv, content_tag, content_ciphertext,
              execution_parameters::text AS execution_parameters
       FROM evaluation_attempts WHERE tenant_id = $1`,
      [tenant.tenantId],
    );
    const row = attempt.rows[0];
    if (row === undefined) throw new Error('attempt is missing');
    expect(row.execution_parameters).not.toContain(PROMPT);
    expect(row.execution_parameters).toContain('temperature');
    const opened = decryptSample(
      sampleKeyManager,
      { tenantId: tenant.tenantId, sampleId: row.id, schemaVersion: row.schema_version },
      {
        schemaVersion: row.schema_version,
        wrappingKeyVersion: row.wrapping_key_version,
        wrappedKeyIv: bufferFrom(row.wrapped_key_iv),
        wrappedKeyTag: bufferFrom(row.wrapped_key_tag),
        wrappedKeyCiphertext: bufferFrom(row.wrapped_key_ciphertext),
        contentIv: bufferFrom(row.content_iv),
        contentTag: bufferFrom(row.content_tag),
        contentCiphertext: bufferFrom(row.content_ciphertext),
      },
    );
    expect(JSON.stringify(opened)).toContain(COMPLETION);
    const traffic = await admin.query<{ traffic_class: string; requested_model: string }>(
      `SELECT traffic_class, requested_model FROM proxy_requests WHERE tenant_id = $1 AND traffic_class = 'evaluation'`,
      [tenant.tenantId],
    );
    expect(traffic.rows).toEqual([{ traffic_class: 'evaluation', requested_model: 'challenger' }]);
    expect(await evaluationCosts(tenant.tenantId)).toBe(1);
    const aliases = await admin.query<{ alias: string; name: string }>(
      `SELECT a.alias, d.name
       FROM model_aliases a
       JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
       WHERE a.tenant_id = $1`,
      [tenant.tenantId],
    );
    const production = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(tenant),
      payload: { model: 'auto', messages: [{ role: 'user', content: 'routing-check' }], max_tokens: 16 },
    });
    expect(production.statusCode).toBe(200);
    expect(parsedHit(openai.hits.at(-1) as MockHit).model).toBe(SOURCE_MODEL);
    const aliasesAfter = await admin.query<{ alias: string; name: string }>(
      `SELECT a.alias, d.name
       FROM model_aliases a
       JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
       WHERE a.tenant_id = $1`,
      [tenant.tenantId],
    );
    expect(aliasesAfter.rows).toEqual(aliases.rows);
    const productionRow = await admin.query<{ traffic_class: string }>(
      `SELECT traffic_class FROM proxy_requests WHERE tenant_id = $1 AND requested_model = 'auto'`,
      [tenant.tenantId],
    );
    expect(productionRow.rows[0]?.traffic_class).toBe('production');
  });

  it('does not call the provider for a sample or deployment from another tenant', async () => {
    const owner = await prepare('Replay Owner');
    const other = await prepare('Replay Other');
    const hitsBefore = openai.hits.length;
    const wrongSample = await createReplay(other.tenant, [owner.sampleId], 'replay-wrong-sample');
    expect(wrongSample.statusCode).toBe(400);
    expect(errorCode(wrongSample.body)).toBe('sample_not_owned');
    const foreign = provisionTenant(db, 'Replay Foreign Deployment');
    runCli(
      db,
      ['register-openai-connection', '--tenant-id', foreign.tenantId, '--api-key', 'sk-test-eval-07b-foreign'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'register-deployment',
        '--tenant-id',
        foreign.tenantId,
        '--name',
        'foreign-only',
        '--upstream-model',
        'gpt-foreign',
        '--timeout-ms',
        '5000',
        '--capabilities',
        'temperature,max_tokens',
        '--enabled',
        'true',
      ],
      cliEnv(),
    );
    const wrongDeployment = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(owner.tenant, { 'idempotency-key': 'replay-wrong-deployment' }),
      payload: {
        name: 'weekly-replay',
        sampleCategory: 'general_qa',
        sampleIds: [owner.sampleId],
        challengerDeployment: 'foreign-only',
        budgetEstimate: '0.25',
        mode: 'replay',
      },
    });
    expect(wrongDeployment.statusCode).toBe(400);
    expect(errorCode(wrongDeployment.json())).toBe('deployment_unauthorized');
    expect(openai.hits.length).toBe(hitsBefore);
  });

  it('fails an expired sample, a revoked permission, a capability mismatch, and bad ciphertext before dispatch', async () => {
    const expired = await prepare('Replay Expired');
    const expiredRun = await createReplay(expired.tenant, [expired.sampleId], 'replay-expired');
    expect(expiredRun.statusCode).toBe(201);
    await mutateSample(
      expired.sampleId,
      `UPDATE request_samples
       SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day'
       WHERE id = $1`,
      [expired.sampleId],
    );
    const hitsBefore = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(expired.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(expired.tenant, expiredRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'sample_expired' }],
    });
    expect(openai.hits.length).toBe(hitsBefore);

    const revoked = await prepare('Replay Revoked');
    const revokedRun = await createReplay(revoked.tenant, [revoked.sampleId], 'replay-revoked');
    setPolicy(revoked.tenant.tenantId, { replay: 'false' });
    const revokedHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(revoked.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(revoked.tenant, revokedRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'replay_denied' }],
    });
    expect(openai.hits.length).toBe(revokedHits);

    const capability = await prepare('Replay Capability');
    const capabilityRun = await createReplay(capability.tenant, [capability.sampleId], 'replay-capability');
    await admin.query(`UPDATE model_deployments SET capabilities = ARRAY['stop']::text[] WHERE tenant_id = $1 AND name = 'challenger'`, [
      capability.tenant.tenantId,
    ]);
    const capabilityHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(capability.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(capability.tenant, capabilityRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'capability_mismatch' }],
    });
    expect(openai.hits.length).toBe(capabilityHits);

    const invalid = await prepare('Replay Invalid');
    const broken = await copySample(invalid.sampleId, { corrupt: true });
    const invalidRun = await createReplay(invalid.tenant, [broken], 'replay-invalid');
    expect(invalidRun.statusCode).toBe(201);
    const invalidHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(invalid.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(invalid.tenant, invalidRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'invalid_canonical' }],
    });
    expect(openai.hits.length).toBe(invalidHits);
  });

  it('stops a call when permission is revoked or the run is cancelled during execution', async () => {
    const revoked = await prepare('Replay Revoke Live');
    const revokedRun = await createReplay(revoked.tenant, [revoked.sampleId], 'replay-revoke-live');
    const hitsBefore = openai.hits.length;
    const options = workerOptions(revoked.tenant.tenantId, {
      beforeDispatch: () => setPolicy(revoked.tenant.tenantId, { replay: 'false' }),
    });
    expect(await pollEvaluationOnce(ctx.runtimePool, options)).toMatchObject({ claimed: true, outcome: 'failed' });
    expect((await readItems(revoked.tenant, revokedRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'replay_denied' }],
    });
    expect(openai.hits.length).toBe(hitsBefore);

    const cancelled = await prepare('Replay Cancel Live');
    const cancelledRun = await createReplay(cancelled.tenant, [cancelled.sampleId], 'replay-cancel-live');
    const cancelOptions = workerOptions(cancelled.tenant.tenantId, {
      beforeDispatch: async () => {
        const response = await ctx.app.inject({
          method: 'POST',
          url: `/internal/v1/evaluations/${cancelledRun.id}/cancel`,
          headers: headers(cancelled.tenant),
          payload: {},
        });
        expect(response.statusCode).toBe(200);
      },
    });
    expect(await pollEvaluationOnce(ctx.runtimePool, cancelOptions)).toMatchObject({ claimed: true, outcome: 'cancelled' });
    const run = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${cancelledRun.id}`,
      headers: headers(cancelled.tenant),
    });
    expect(run.json()).toMatchObject({ status: 'cancelled' });
    expect(openai.hits.length).toBe(hitsBefore + 1);
  });

  it('records timeout, rate limit, malformed output, missing usage, and missing cost', async () => {
    const timeout = await prepare('Replay Timeout');
    await admin.query(`UPDATE model_deployments SET timeout_ms = 200 WHERE tenant_id = $1 AND name = 'challenger'`, [
      timeout.tenant.tenantId,
    ]);
    const timeoutRun = await createReplay(timeout.tenant, [timeout.sampleId], 'replay-timeout');
    mode = 'hang';
    try {
      expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(timeout.tenant.tenantId))).toMatchObject({
        claimed: true,
        outcome: 'failed',
      });
    } finally {
      mode = 'ok';
    }
    expect((await readItems(timeout.tenant, timeoutRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'provider_timeout' }],
    });

    const limited = await prepare('Replay 429');
    const limitedRun = await createReplay(limited.tenant, [limited.sampleId], 'replay-429');
    mode = 'rate';
    try {
      expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(limited.tenant.tenantId))).toMatchObject({
        claimed: true,
        outcome: 'failed',
      });
    } finally {
      mode = 'ok';
    }
    expect((await readItems(limited.tenant, limitedRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'provider_rate_limited' }],
    });

    const malformed = await prepare('Replay Malformed');
    const malformedRun = await createReplay(malformed.tenant, [malformed.sampleId], 'replay-malformed');
    mode = 'malformed';
    try {
      expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(malformed.tenant.tenantId))).toMatchObject({
        claimed: true,
        outcome: 'failed',
      });
    } finally {
      mode = 'ok';
    }
    expect((await readItems(malformed.tenant, malformedRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'malformed_output' }],
    });

    const missingUsage = await prepare('Replay No Usage');
    const missingUsageRun = await createReplay(missingUsage.tenant, [missingUsage.sampleId], 'replay-no-usage');
    mode = 'nousage';
    try {
      expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(missingUsage.tenant.tenantId))).toMatchObject({
        claimed: true,
        outcome: 'failed',
      });
    } finally {
      mode = 'ok';
    }
    const usageItems = await readItems(missingUsage.tenant, missingUsageRun.id);
    expect(usageItems.json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'usage_missing', promptTokens: null, completionTokens: null, totalTokens: null }],
    });
    expect(usageItems.body).not.toContain(COMPLETION);
    const sealed = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM evaluation_attempts
       WHERE tenant_id = $1 AND content_ciphertext IS NOT NULL AND reason_code = 'usage_missing'`,
      [missingUsage.tenant.tenantId],
    );
    expect(sealed.rows[0]?.count).toBe(1);

    const missingCost = await prepare('Replay No Cost', { challengerModel: UNPRICED_MODEL, budget: { mode: 'observe', amount: '10' } });
    const missingCostRun = await createReplay(missingCost.tenant, [missingCost.sampleId], 'replay-no-cost');
    const hitsBefore = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(missingCost.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect(openai.hits.length).toBe(hitsBefore + 1);
    expect((await readItems(missingCost.tenant, missingCostRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'cost_missing', costStatus: 'unknown', costAmount: null }],
    });
  });

  it('does not call the provider when the evaluation budget is exceeded', async () => {
    const { tenant, sampleId } = await prepare('Replay Budget');
    const created = await createReplay(tenant, [sampleId], 'replay-budget');
    expect(created.statusCode).toBe(201);
    runCli(db, ['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '0.01'], cliEnv());
    const hitsBefore = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId))).toMatchObject({ claimed: true, outcome: 'failed' });
    expect((await readItems(tenant, created.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'budget_exceeded' }],
    });
    expect(openai.hits.length).toBe(hitsBefore);
    expect(await evaluationCosts(tenant.tenantId)).toBe(0);
  });

  it('does not dispatch after a crash before the call and does not repeat a call after dispatch', async () => {
    const before = await prepare('Replay Crash Before');
    const beforeRun = await createReplay(before.tenant, [before.sampleId], 'replay-crash-before');
    const hitsBefore = openai.hits.length;
    const stopped = await pollEvaluationOnce(
      ctx.runtimePool,
      workerOptions(before.tenant.tenantId, { stopBeforeDispatch: true }),
    );
    expect(stopped).toEqual({ claimed: true, outcome: 'not_dispatched' });
    expect(openai.hits.length).toBe(hitsBefore);
    await admin.query(
      `UPDATE evaluation_jobs SET locked_until = now() - interval '1 second' WHERE run_id = $1 AND status = 'running'`,
      [beforeRun.id],
    );
    const recovered = await pollEvaluationOnce(ctx.runtimePool, workerOptions(before.tenant.tenantId));
    expect(recovered).toMatchObject({ claimed: true, outcome: 'failed' });
    expect((await readItems(before.tenant, beforeRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'not_dispatched' }],
    });
    expect(openai.hits.length).toBe(hitsBefore);
    expect(await evaluationCosts(before.tenant.tenantId)).toBe(0);

    const after = await prepare('Replay Crash After');
    const afterRun = await createReplay(after.tenant, [after.sampleId], 'replay-crash-after');
    const hitsAfter = openai.hits.length;
    const dispatched = await pollEvaluationOnce(
      ctx.runtimePool,
      workerOptions(after.tenant.tenantId, { stopAfterDispatch: true }),
    );
    expect(dispatched).toEqual({ claimed: true, outcome: 'dispatched' });
    expect(openai.hits.length).toBe(hitsAfter);
    await admin.query(
      `UPDATE evaluation_jobs SET locked_until = now() - interval '1 second' WHERE run_id = $1 AND status = 'running'`,
      [afterRun.id],
    );
    const uncertain = await pollEvaluationOnce(ctx.runtimePool, workerOptions(after.tenant.tenantId));
    expect(uncertain).toMatchObject({ claimed: true, outcome: 'failed' });
    expect((await readItems(after.tenant, afterRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'uncertain' }],
    });
    expect(await evaluationCosts(after.tenant.tenantId)).toBe(1);
    expect(openai.hits.length).toBe(hitsAfter);
    await admin.query(
      `UPDATE evaluation_jobs SET status = 'running', locked_until = now() - interval '1 second' WHERE run_id = $1`,
      [afterRun.id],
    );
    const duplicate = await pollEvaluationOnce(ctx.runtimePool, workerOptions(after.tenant.tenantId));
    expect(duplicate).toMatchObject({ claimed: true, outcome: 'duplicate' });
    expect(await evaluationCosts(after.tenant.tenantId)).toBe(1);
    expect(openai.hits.length).toBe(hitsAfter);
  });

  it('does not apply a duplicate delivery of a completed replay', async () => {
    const { tenant, sampleId } = await prepare('Replay Duplicate');
    const created = await createReplay(tenant, [sampleId], 'replay-duplicate');
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'completed',
    });
    const hits = openai.hits.length;
    const costs = await evaluationCosts(tenant.tenantId);
    await admin.query(
      `UPDATE evaluation_jobs SET status = 'running', locked_until = now() - interval '1 second' WHERE run_id = $1`,
      [created.id],
    );
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'duplicate',
    });
    expect(openai.hits.length).toBe(hits);
    expect(await evaluationCosts(tenant.tenantId)).toBe(costs);
    expect((await readItems(tenant, created.id)).json).toMatchObject({
      items: [{ status: 'completed', reasonCode: 'replay_completed' }],
    });
  });

  it('keeps two evaluations inside the tenant concurrency limit and blocks a second request rate', async () => {
    const concurrent = await prepare('Replay Concurrent');
    const extra = await copySample(concurrent.sampleId);
    const created = await createReplay(concurrent.tenant, [concurrent.sampleId, extra], 'replay-concurrent');
    expect(created.statusCode).toBe(201);
    runCli(
      db,
      ['set-tenant-limits', '--tenant-id', concurrent.tenant.tenantId, '--mode', 'hard', '--concurrent-requests', '1'],
      cliEnv(),
    );
    const hitsBefore = openai.hits.length;
    const options = workerOptions(concurrent.tenant.tenantId);
    let nested = false;
    options.beforeDispatch = async () => {
      if (nested) return;
      nested = true;
      const second = await pollEvaluationOnce(ctx.runtimePool, options);
      expect(second.outcome).toBe('failed');
    };
    const first = await pollEvaluationOnce(ctx.runtimePool, options);
    expect(first.outcome).toBe('completed');
    expect(openai.hits.length).toBe(hitsBefore + 1);
    const items = await readItems(concurrent.tenant, created.id);
    const reasons = (items.json as { items: Array<{ reasonCode: string | null }> }).items.map((item) => item.reasonCode);
    expect(reasons.sort()).toEqual(['concurrency_limited', 'replay_completed']);

    const rated = await prepare('Replay Rate');
    runCli(
      db,
      ['set-tenant-limits', '--tenant-id', rated.tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1'],
      cliEnv(),
    );
    const consumed = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(rated.tenant),
      payload: { model: 'chat', messages: [{ role: 'user', content: 'rate-slot' }], max_tokens: 16 },
    });
    expect(consumed.statusCode).toBe(200);
    const ratedRun = await createReplay(rated.tenant, [rated.sampleId], 'replay-rate');
    const ratedHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(rated.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(rated.tenant, ratedRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'rate_limited' }],
    });
    expect(openai.hits.length).toBe(ratedHits);
  });

  it('rejects tool input, leaves routing unchanged, and replays twenty samples without leaking text', async () => {
    const tools = await prepare('Replay Tools');
    const tooled = await sealToolsSample(tools.tenant.tenantId, tools.sampleId);
    const toolsRun = await createReplay(tools.tenant, [tooled], 'replay-tools');
    const hitsBefore = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(tools.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(tools.tenant, toolsRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'semantic_rejected' }],
    });
    expect(openai.hits.length).toBe(hitsBefore);

    const batch = await prepare('Replay Twenty');
    const ids = [batch.sampleId];
    for (let index = 0; index < 19; index += 1) ids.push(await copySample(batch.sampleId));
    const created = await createReplay(batch.tenant, ids, 'replay-twenty');
    expect(created.statusCode).toBe(201);
    const batchHits = openai.hits.length;
    workerLogger.lines.length = 0;
    for (let index = 0; index < 20; index += 1) {
      const polled = await pollEvaluationOnce(ctx.runtimePool, workerOptions(batch.tenant.tenantId));
      expect(polled.outcome).toBe('completed');
    }
    expect(openai.hits.length).toBe(batchHits + 20);
    const items = await readItems(batch.tenant, created.id);
    expect(items.body).not.toContain(PROMPT);
    expect(items.body).not.toContain(COMPLETION);
    const parsed = items.json as { items: Array<{ status: string; reasonCode: string | null }> };
    expect(parsed.items).toHaveLength(20);
    expect(parsed.items.every((item) => item.status === 'completed' && item.reasonCode === 'replay_completed')).toBe(true);
    expect(workerLogger.lines.join('\n')).not.toContain(PROMPT);
    expect(workerLogger.lines.join('\n')).not.toContain(COMPLETION);
  });

  it('stays idle for another tenant, stops on the kill switch, and still loads a dry run', async () => {
    const enabled = await prepare('Replay Allow');
    const blocked = await prepare('Replay Blocked');
    const enabledRun = await createReplay(enabled.tenant, [enabled.sampleId], 'replay-allow');
    const blockedRun = await createReplay(blocked.tenant, [blocked.sampleId], 'replay-blocked');
    const hitsBefore = openai.hits.length;
    const skipped = await pollEvaluationOnce(ctx.runtimePool, workerOptions(enabled.tenant.tenantId, { executionEnabled: false }));
    expect(skipped).toEqual({ claimed: false, outcome: 'skipped' });
    const other = await pollEvaluationOnce(ctx.runtimePool, workerOptions(enabled.tenant.tenantId));
    expect(other.outcome).toBe('completed');
    const blockedPoll = await pollEvaluationOnce(ctx.runtimePool, workerOptions(enabled.tenant.tenantId));
    expect(blockedPoll).toEqual({ claimed: false, outcome: 'idle' });
    const blockedItems = await readItems(blocked.tenant, blockedRun.id);
    expect(blockedItems.json).toMatchObject({ items: [{ status: 'queued', reasonCode: null }] });
    expect((await readItems(enabled.tenant, enabledRun.id)).json).toMatchObject({
      items: [{ status: 'completed', reasonCode: 'replay_completed' }],
    });

    const killed = await prepare('Replay Kill');
    const second = await copySample(killed.sampleId);
    const killedRun = await createReplay(killed.tenant, [killed.sampleId, second], 'replay-kill');
    const killOptions = workerOptions(killed.tenant.tenantId);
    killOptions.beforeDispatch = () => {
      killOptions.executionEnabled = false;
    };
    expect(await pollEvaluationOnce(ctx.runtimePool, killOptions)).toMatchObject({ claimed: true, outcome: 'failed' });
    expect(await pollEvaluationOnce(ctx.runtimePool, killOptions)).toEqual({ claimed: false, outcome: 'skipped' });
    const killedItems = await readItems(killed.tenant, killedRun.id);
    const killedReasons = (killedItems.json as { items: Array<{ status: string; reasonCode: string | null }> }).items;
    expect(killedReasons.map((item) => item.reasonCode).sort()).toEqual(['kill_switch', null]);
    expect(killedReasons.map((item) => item.status).sort()).toEqual(['failed', 'queued']);

    const dry = await prepare('Replay Dry');
    const dryResponse = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(dry.tenant, { 'idempotency-key': 'replay-dry' }),
      payload: {
        name: 'weekly-dry',
        sampleCategory: 'general_qa',
        sampleIds: [dry.sampleId],
        challengerDeployment: 'challenger',
        budgetEstimate: '0.25',
        mode: 'dry_run',
      },
    });
    expect(dryResponse.statusCode).toBe(201);
    expect(dryResponse.json()).toMatchObject({ mode: 'dry_run', modelExecution: 'off' });
    const dryHits = openai.hits.length;
    expect(
      await pollEvaluationOnce(ctx.runtimePool, {
        workerId: 'dry-worker',
        dryRun: true,
        executionEnabled: false,
      }),
    ).toMatchObject({ claimed: true, outcome: 'completed' });
    expect(openai.hits.length).toBe(dryHits);
    expect(openai.hits.length).toBeGreaterThanOrEqual(hitsBefore);
  });

  it('fails unhealthy and residency checks before the provider call', async () => {
    const unhealthy = await prepare('Replay Unhealthy');
    const unhealthyRun = await createReplay(unhealthy.tenant, [unhealthy.sampleId], 'replay-unhealthy');
    runCli(
      db,
      ['set-deployment-health', '--tenant-id', unhealthy.tenant.tenantId, '--deployment', 'challenger', '--status', 'unhealthy'],
      cliEnv(),
    );
    const hitsBefore = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(unhealthy.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(unhealthy.tenant, unhealthyRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'deployment_unhealthy' }],
    });
    expect(openai.hits.length).toBe(hitsBefore);

    const resident = await prepare('Replay Residency');
    const residentRun = await createReplay(resident.tenant, [resident.sampleId], 'replay-residency');
    await mutateSample(resident.sampleId, `UPDATE request_samples SET source_location = 'europe-west1' WHERE id = $1`, [
      resident.sampleId,
    ]);
    const residentHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(resident.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(resident.tenant, residentRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'residency_denied' }],
    });
    expect(openai.hits.length).toBe(residentHits);
  });

  it('reads a half-open breaker and does not take the production probe', async () => {
    const ready = await prepare('Replay Breaker Probe');
    const readyRun = await createReplay(ready.tenant, [ready.sampleId], 'replay-breaker-probe');
    expect(readyRun.statusCode).toBe(201);
    enableChallengerBreaker(ready.tenant.tenantId);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'half_open',
           state_reason = 'cooldown_elapsed',
           cooldown_until = now() - interval '1 second',
           probes_inflight = 0
       WHERE tenant_id = $1`,
      [ready.tenant.tenantId],
    );
    const before = await breakerSnap(ready.tenant.tenantId);
    const hitsBefore = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(ready.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'completed',
    });
    expect(openai.hits.length).toBe(hitsBefore + 1);
    expect((await readItems(ready.tenant, readyRun.id)).json).toMatchObject({
      items: [{ status: 'completed', reasonCode: 'replay_completed' }],
    });
    const after = await breakerSnap(ready.tenant.tenantId);
    expect(after).toEqual(before);
    expect(after.probes_inflight).toBe(0);
    expect(after.state).toBe('half_open');

    const firstProbe = await guardUpstream(ctx.runtimePool, ready.tenant.tenantId, after.deployment_id, new Date());
    expect(firstProbe).toEqual({ allow: true, probe: true, track: true });
    const held = await breakerSnap(ready.tenant.tenantId);
    expect(held.probes_inflight).toBe(1);
    expect(held.state).toBe('half_open');
    const secondProbe = await guardUpstream(ctx.runtimePool, ready.tenant.tenantId, after.deployment_id, new Date());
    expect(secondProbe.allow).toBe(false);
    expect((await breakerSnap(ready.tenant.tenantId)).probes_inflight).toBe(1);

    const elapsed = await prepare('Replay Breaker Elapsed');
    const elapsedRun = await createReplay(elapsed.tenant, [elapsed.sampleId], 'replay-breaker-elapsed');
    enableChallengerBreaker(elapsed.tenant.tenantId);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'open',
           state_reason = 'failure_threshold',
           cooldown_until = now() - interval '1 second',
           probes_inflight = 0
       WHERE tenant_id = $1`,
      [elapsed.tenant.tenantId],
    );
    const elapsedBefore = await breakerSnap(elapsed.tenant.tenantId);
    const elapsedHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(elapsed.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'completed',
    });
    expect(openai.hits.length).toBe(elapsedHits + 1);
    expect((await readItems(elapsed.tenant, elapsedRun.id)).json).toMatchObject({
      items: [{ status: 'completed', reasonCode: 'replay_completed' }],
    });
    const elapsedAfter = await breakerSnap(elapsed.tenant.tenantId);
    expect(elapsedAfter).toEqual(elapsedBefore);
    expect(elapsedAfter.state).toBe('open');
    expect(elapsedAfter.probes_inflight).toBe(0);
    const elapsedProbe = await guardUpstream(
      ctx.runtimePool,
      elapsed.tenant.tenantId,
      elapsedAfter.deployment_id,
      new Date(),
    );
    expect(elapsedProbe).toEqual({ allow: true, probe: true, track: true });
    const elapsedHeld = await breakerSnap(elapsed.tenant.tenantId);
    expect(elapsedHeld.state).toBe('half_open');
    expect(elapsedHeld.probes_inflight).toBe(1);

    const cooling = await prepare('Replay Breaker Open');
    const coolingRun = await createReplay(cooling.tenant, [cooling.sampleId], 'replay-breaker-open');
    enableChallengerBreaker(cooling.tenant.tenantId);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'open',
           state_reason = 'failure_threshold',
           cooldown_until = now() + interval '1 hour',
           probes_inflight = 0
       WHERE tenant_id = $1`,
      [cooling.tenant.tenantId],
    );
    const coolingBefore = await breakerSnap(cooling.tenant.tenantId);
    const coolingHits = openai.hits.length;
    expect(await pollEvaluationOnce(ctx.runtimePool, workerOptions(cooling.tenant.tenantId))).toMatchObject({
      claimed: true,
      outcome: 'failed',
    });
    expect((await readItems(cooling.tenant, coolingRun.id)).json).toMatchObject({
      items: [{ status: 'failed', reasonCode: 'deployment_unhealthy' }],
    });
    expect(openai.hits.length).toBe(coolingHits);
    expect(await breakerSnap(cooling.tenant.tenantId)).toEqual(coolingBefore);
    const stillOpen = await guardUpstream(
      ctx.runtimePool,
      cooling.tenant.tenantId,
      coolingBefore.deployment_id,
      new Date(),
    );
    expect(stillOpen).toEqual({ allow: false, probe: false, track: true });
    expect((await breakerSnap(cooling.tenant.tenantId)).probes_inflight).toBe(0);
  });
});

describe.skipIf(process.env.OPENAI_LIVE !== '1')('optional live challenger replay', () => {
  it('is not part of the mock suite', () => {
    expect(process.env.OPENAI_API_KEY?.length ?? 0).toBeGreaterThan(0);
  });
});

function bufferFrom(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new Error('ciphertext is not bytes');
}
