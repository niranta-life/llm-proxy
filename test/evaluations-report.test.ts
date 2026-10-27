import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { criteriaForCategory } from '../src/inference/judge.js';
import { createTestApp, freePort, loadTestDatabase, runCli, serviceEnv, spawnServer, stopChild, waitForReady } from './helpers.js';
import { adminPool, cliEnv, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';

const PROMPT = 'eval-slice-07e-prompt-token';
const COMPLETION = 'eval-slice-07e-completion-token';
const LONG_MODEL = `a${'b'.repeat(64)}`;
const JUDGE_MODEL = 'vendor://model';
const CRITERIA = criteriaForCategory('general_qa');

type Tenant = { tenantId: string; secret: string; keyId: string; name: string };
type AppCtx = Awaited<ReturnType<typeof createTestApp>>;
type Outcome = 'model_a' | 'model_b' | 'tie' | 'inconclusive' | 'unstable';
type ReportBody = {
  evaluationId: string;
  status: string;
  readOnly: boolean;
  routingChange: boolean;
  generatedAt: string;
  samples: { total: number; validPairs: number; excluded: number; exclusionReasons: Record<string, number> };
  quality: {
    comparable: boolean;
    incomparableReasons: string[];
    objective: {
      original: { pass: number; fail: number; notApplicable: number; unknown: number; rate: number | null };
      challenger: { pass: number; fail: number; notApplicable: number; unknown: number; rate: number | null };
    };
    judge: { originalWins: number; challengerWins: number; ties: number; unstable: number; inconclusive: number };
  };
  cost: {
    original: { total: string | null; status: string; missing: number };
    challenger: { total: string | null; status: string; missing: number };
    evaluationExpense: { amount: string | null; status: string };
    challengerAttempts: Array<{ amount: string | null; status: string | null }>;
  };
  latency: {
    evaluation: { medianMs: number | null; p95Ms: number | null; comparableToEvaluation: boolean };
    historical: { medianMs: number | null; comparableToEvaluation: boolean };
    note: string;
  };
  reliability: { attempted: number; completed: number; rate: number | null };
  models: { challengerModels: string[]; judgeModels: string[] };
  recommendation: {
    evaluationId: string;
    state: string;
    readOnly: boolean;
    routingChange: boolean;
    evidenceIds: { runId: string; itemIds: string[]; findingIds: string[]; attemptIds: string[] };
    profileVersion: { id: string; version: number | null } | null;
    sampleCount: number;
    totalSamples: number;
    exclusionCount: number;
    qualityCriteria: { minimumValidPairs: number; taskCategory: string; objectivePassRateFloor: number; gate: string };
    uncertainty: {
      method: string;
      equivalentQuality: boolean;
      direction: string;
      judge: { lower: number; upper: number; successes: number; trials: number } | null;
    };
    cost: { evaluationExpense: { amount: string | null; status: string }; challenger: { total: string | null; missing: number } };
    latency: { evaluation: { medianMs: number | null }; historical: { medianMs: number | null; comparableToEvaluation: boolean } };
    reliability: { rate: number | null };
    reasonCodes: string[];
    limitations: string[];
    modelVersions: { challengerModels: string[]; judgeModels: string[]; adapterVersions: number[] };
    generatedAt: string;
  };
};

type Seed = {
  valid: number;
  excluded?: number;
  failedAttempts?: number;
  outcome?: Outcome | 'none';
  objective?: 'pass' | 'fail_challenger' | 'not_applicable' | 'none';
  extraObjective?: boolean;
  cost?: { amount: string | null; status: string | null };
  originalCost?: { amount: string; status: string } | null;
  latencyMs?: number;
  historicalMs?: number;
  adapterSplit?: boolean;
  mixTask?: boolean;
  mixRubric?: boolean;
  mixProfile?: boolean;
  finish?: boolean;
  judgeModel?: string;
  challengerModel?: string;
};

describe('evaluation analysis reports', () => {
  const db = loadTestDatabase();
  let openai: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: AppCtx;
  let admin: ReturnType<typeof adminPool>;
  let tenant: Tenant;
  let other: Tenant;
  let templateId = '';
  let profile: { id: string; versionId: string; version: number };
  let rubric: { id: string; versionId: string; version: number };
  let otherProfileId = '';
  let otherRubricId = '';
  let names = 0;
  const runs = new Map<string, string>();

  beforeAll(async () => {
    openai = await startMockUpstream((_hit, _request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody('gpt-eval', COMPLETION)));
    });
    admin = adminPool(db);
    ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: openai.baseUrl, credentialKey });
    tenant = provisionTenant(db, 'Report Owner');
    other = provisionTenant(db, 'Report Other');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-test-eval-07e',
      deployment: 'chat',
      upstreamModel: 'gpt-eval',
      capabilities: 'temperature,stop',
    });
    setPolicy(tenant.tenantId);
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-test-eval-07e-other',
      deployment: 'chat',
      upstreamModel: 'gpt-eval',
      capabilities: 'temperature,stop',
    });
    setPolicy(other.tenantId);
    templateId = await capture(tenant);
    profile = await approveProfile(tenant, 'report-profile');
    rubric = await approveRubric(tenant, 'report-rubric');
    otherProfileId = (await approveProfile(tenant, 'report-profile-b')).versionId;
    otherRubricId = (await approveRubric(tenant, 'report-rubric-b')).versionId;
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await openai.close();
  });

  function setPolicy(tenantId: string): void {
    runCli(db, ['set-deployment-data-class', '--tenant-id', tenantId, '--deployment', 'chat', '--data-class', 'internal'], cliEnv());
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
        'true',
        '--judge-disclosure',
        'true',
        '--sample-rate',
        '1',
        '--max-sample-bytes',
        '1000000',
        '--max-sample-count',
        '1000',
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
  }

  function headers(caller: Tenant, extra: Record<string, string> = {}): Record<string, string> {
    return { 'content-type': 'application/json', 'x-tenant-id': caller.tenantId, authorization: `Bearer ${caller.secret}`, ...extra };
  }

  async function capture(caller: Tenant): Promise<string> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: headers(caller),
      payload: { model: 'chat', messages: [{ role: 'user', content: PROMPT }], task: 'general_qa', temperature: 0 },
    });
    expect(response.statusCode).toBe(200);
    const stored = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [caller.tenantId],
    );
    const id = stored.rows[0]?.id;
    if (id === undefined) throw new Error('sample was not stored');
    return id;
  }

  async function cloneSample(taskCategory: string | null = null): Promise<string> {
    const source = await admin.query<Record<string, unknown>>(
      `SELECT request_id, tenant_id, policy_id, policy_version, provider, deployment_name, data_classification,
              schema_version, size_bytes, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext, slot, task_category, input_size, complexity, text_only,
              required_capabilities, source_location
       FROM request_samples WHERE id = $1`,
      [templateId],
    );
    const row = source.rows[0];
    if (row === undefined) throw new Error('template sample is missing');
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
         $14, $15, $16, now(), now() + interval '1 day',
         NULL, $17, $18, $19, $20,
         true, $21, $22, $23
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
        row.slot,
        taskCategory ?? row.task_category,
        row.input_size,
        row.complexity,
        row.text_only,
        row.required_capabilities,
        row.source_location,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('clone was not stored');
    return id;
  }

  async function approveProfile(caller: Tenant, name: string): Promise<{ id: string; versionId: string; version: number }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: headers(caller),
      payload: {
        name,
        taskCategory: 'general_qa',
        config: {
          limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 },
          validators: [{ id: 'json_parse', version: 1 }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { id: string; versionId: string; version: number };
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${body.id}/versions/${body.version}/approve`,
      headers: headers(caller),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return body;
  }

  async function approveRubric(caller: Tenant, name: string): Promise<{ id: string; versionId: string; version: number }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-rubrics',
      headers: headers(caller),
      payload: { name, taskCategory: 'general_qa', config: { criteria: CRITERIA } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { id: string; versionId: string; version: number };
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-rubrics/${body.id}/versions/${body.version}/approve`,
      headers: headers(caller),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return body;
  }

  async function seed(spec: Seed): Promise<string> {
    const total = spec.valid + (spec.excluded ?? 0);
    const sampleIds: string[] = [];
    for (let index = 0; index < total; index += 1) sampleIds.push(await cloneSample());
    const needsJudge = spec.outcome !== undefined && spec.outcome !== 'none';
    const needsProfile = spec.objective !== undefined && spec.objective !== 'none';
    names += 1;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(tenant, { 'idempotency-key': `report-${names}-${randomUUID()}` }),
      payload: {
        name: `report-${names}`,
        sampleCategory: 'general_qa',
        sampleIds,
        challengerDeployment: 'chat',
        ...(needsJudge ? { judgeDeployment: 'chat' } : {}),
        budgetEstimate: '0.25',
        mode: 'replay',
        ...(needsProfile ? { profileVersionId: profile.versionId } : {}),
        ...(needsJudge ? { rubricVersionId: rubric.versionId } : {}),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const runId = (created.json() as { id: string }).id;
    if (spec.finish === false) return runId;
    const items = await admin.query<{ id: string; sample_id: string; request_id: string }>(
      `SELECT i.id::text AS id, i.sample_id::text AS sample_id, s.request_id::text AS request_id
       FROM evaluation_items i
       JOIN request_samples s ON s.id = i.sample_id
       WHERE i.run_id = $1
       ORDER BY i.ordinal`,
      [runId],
    );
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const validItems = items.rows.slice(0, spec.valid);
      const excludedItems = items.rows.slice(spec.valid);
      const failedAttemptItems = excludedItems.slice(0, spec.failedAttempts ?? 0);
      const bareExcluded = excludedItems.slice(spec.failedAttempts ?? 0);
      const costAmount = spec.cost === undefined ? '0.01' : spec.cost.amount;
      const costStatus = spec.cost === undefined ? 'reconciled' : spec.cost.status;
      if (spec.mixTask === true && sampleIds[0] !== undefined) {
        await client.query(`SET LOCAL session_replication_role = replica`);
        await client.query(`UPDATE request_samples SET task_category = 'coding' WHERE id = $1`, [sampleIds[0]]);
        await client.query(`SET LOCAL session_replication_role = DEFAULT`);
      }
      for (const [index, item] of validItems.entries()) {
        await insertOriginal(client, item.request_id, spec.historicalMs ?? 100, spec.originalCost ?? null);
        await insertAttempt(client, {
          runId,
          itemId: item.id,
          sampleId: item.sample_id,
          status: 'completed',
          reason: 'replay_completed',
          latencyMs: spec.latencyMs ?? 80,
          costAmount,
          costStatus,
          adapterVersion: spec.adapterSplit === true && index === 1 ? 2 : 1,
          challengerModel: spec.challengerModel ?? 'gpt-07e-challenger',
        });
        if (needsProfile) {
          const profileId = spec.mixProfile === true && index === 0 ? otherProfileId : profile.versionId;
          const originalResult = spec.objective === 'not_applicable' ? 'not_applicable' : 'pass';
          const challengerResult = spec.objective === 'fail_challenger' ? 'fail' : originalResult;
          await insertValidator(client, runId, item.id, profileId, 'original', originalResult);
          await insertValidator(client, runId, item.id, profileId, 'challenger', challengerResult);
          if (spec.extraObjective === true && index === 0) {
            await insertValidator(client, runId, item.id, profileId, 'challenger', 'not_applicable', 'format_length');
            await insertValidator(client, runId, item.id, profileId, 'original', 'unknown', 'required_fields');
          }
        }
        if (needsJudge) {
          const rubricId = spec.mixRubric === true && index === 0 ? otherRubricId : rubric.versionId;
          await insertFinding(client, {
            runId,
            itemId: item.id,
            rubricId,
            outcome: spec.outcome === 'none' || spec.outcome === undefined ? 'tie' : spec.outcome,
            judgeModel: spec.judgeModel ?? 'gpt-07e-judge',
            costAmount,
            costStatus,
          });
        }
      }
      for (const item of failedAttemptItems) {
        await insertAttempt(client, {
          runId,
          itemId: item.id,
          sampleId: item.sample_id,
          status: 'failed',
          reason: 'provider_error',
          latencyMs: null,
          costAmount,
          costStatus,
          adapterVersion: 1,
          challengerModel: spec.challengerModel ?? 'gpt-07e-challenger',
        });
      }
      if (validItems.length > 0) {
        await client.query(
          `UPDATE evaluation_items SET status = 'completed', reason_code = 'replay_completed', updated_at = now() WHERE id = ANY($1::uuid[])`,
          [validItems.map((item) => item.id)],
        );
      }
      if (failedAttemptItems.length > 0) {
        await client.query(
          `UPDATE evaluation_items SET status = 'failed', reason_code = 'provider_error', updated_at = now() WHERE id = ANY($1::uuid[])`,
          [failedAttemptItems.map((item) => item.id)],
        );
      }
      if (bareExcluded.length > 0) {
        await client.query(
          `UPDATE evaluation_items SET status = 'failed', reason_code = 'sample_expired', updated_at = now() WHERE id = ANY($1::uuid[])`,
          [bareExcluded.map((item) => item.id)],
        );
      }
      await client.query(
        `UPDATE evaluation_runs
         SET status = $2, pending_count = 0, queued_count = 0, running_count = 0,
             completed_count = $3, failed_count = $4, cancelled_count = 0, updated_at = now()
         WHERE id = $1`,
        [runId, excludedItems.length > 0 ? 'completed_partial' : 'completed', validItems.length, excludedItems.length],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return runId;
  }

  async function insertOriginal(
    client: import('pg').PoolClient,
    requestId: string,
    durationMs: number,
    cost: { amount: string; status: string } | null,
  ): Promise<void> {
    const existing = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM model_attempts WHERE request_id = $1 ORDER BY created_at LIMIT 1`,
      [requestId],
    );
    let attemptId = existing.rows[0]?.id;
    if (attemptId === undefined) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO model_attempts (
           tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status, duration_ms
         )
         SELECT tenant_id, id, deployment_id, deployment_config_version, 'gpt-eval', 'succeeded', $2
         FROM proxy_requests WHERE id = $1
         RETURNING id::text AS id`,
        [requestId, durationMs],
      );
      attemptId = inserted.rows[0]?.id;
    } else {
      await client.query(`UPDATE model_attempts SET duration_ms = $2 WHERE id = $1`, [attemptId, durationMs]);
    }
    if (attemptId === undefined) throw new Error('original attempt was not stored');
    if (cost !== null) {
      await client.query(
        `INSERT INTO attempt_costs (tenant_id, attempt_id, cost_status, amount)
         SELECT tenant_id, $2, $3, $4 FROM proxy_requests WHERE id = $1
         ON CONFLICT (tenant_id, attempt_id) DO NOTHING`,
        [requestId, attemptId, cost.status, cost.amount],
      );
    }
  }

  async function insertAttempt(
    client: import('pg').PoolClient,
    input: {
      runId: string;
      itemId: string;
      sampleId: string;
      status: string;
      reason: string;
      latencyMs: number | null;
      costAmount: string | null;
      costStatus: string | null;
      adapterVersion: number;
      challengerModel: string;
    },
  ): Promise<void> {
    await client.query(
      `WITH source AS (
         SELECT pr.tenant_id, pr.deployment_id, pr.deployment_config_version, pr.connection_id, pr.connection_version
         FROM request_samples s
         JOIN proxy_requests pr ON pr.tenant_id = s.tenant_id AND pr.id = s.request_id
         WHERE s.id = $1
       ),
       req AS (
         INSERT INTO proxy_requests (
           tenant_id, deployment_id, deployment_config_version, connection_id, connection_version,
           requested_model, status, traffic_class, completed_at
         )
         SELECT tenant_id, deployment_id, deployment_config_version, connection_id, connection_version,
                $2, 'succeeded', 'evaluation', now()
         FROM source
         RETURNING id, tenant_id, deployment_id, deployment_config_version
       ),
       attempt AS (
         INSERT INTO model_attempts (
           tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status
         )
         SELECT tenant_id, id, deployment_id, deployment_config_version, $2, 'succeeded' FROM req
         RETURNING id, tenant_id
       )
       INSERT INTO evaluation_attempts (
         tenant_id, run_id, item_id, sample_id, request_id, model_attempt_id, status, reason_code,
         original_deployment, challenger_deployment, config_version, adapter_version, execution_parameters,
         latency_ms, cost_amount, cost_status
       )
       SELECT attempt.tenant_id, $3, $4, $1, req.id, attempt.id, $5, $6,
              'chat', 'chat', req.deployment_config_version, $7, '{}'::jsonb, $8::integer, $9::numeric, $10::text
       FROM attempt
       JOIN req ON req.tenant_id = attempt.tenant_id`,
      [
        input.sampleId,
        input.challengerModel,
        input.runId,
        input.itemId,
        input.status,
        input.reason,
        input.adapterVersion,
        input.latencyMs,
        input.costAmount,
        input.costStatus,
      ],
    );
  }

  async function insertValidator(
    client: import('pg').PoolClient,
    runId: string,
    itemId: string,
    profileVersionId: string,
    candidate: string,
    result: string,
    validatorId = 'json_parse',
  ): Promise<void> {
    await client.query(
      `INSERT INTO evaluation_validator_results (
         tenant_id, run_id, item_id, profile_version_id, candidate, validator_id, validator_version,
         result, measured, evidence_code, reference_present
       )
       SELECT tenant_id, $1, $2, $3, $4, $5, 1, $6, '{}'::jsonb, 'stored_check', false
       FROM evaluation_runs WHERE id = $1`,
      [runId, itemId, profileVersionId, candidate, validatorId, result],
    );
  }

  async function insertFinding(
    client: import('pg').PoolClient,
    input: {
      runId: string;
      itemId: string;
      rubricId: string;
      outcome: Outcome;
      judgeModel: string;
      costAmount: string | null;
      costStatus: string | null;
    },
  ): Promise<void> {
    const mapped =
      input.outcome === 'model_b' ? 'challenger' : input.outcome === 'model_a' ? 'original' : input.outcome === 'tie' ? 'tie' : null;
    const forward = input.outcome === 'unstable' ? 'original' : mapped;
    const reverse = input.outcome === 'unstable' ? 'challenger' : mapped;
    const stop = input.outcome === 'inconclusive' ? 'parse_rejected' : null;
    await client.query(
      `INSERT INTO evaluation_judge_findings (
         tenant_id, run_id, item_id, rubric_version_id, judge_model, rubric_version, outcome,
         forward_mapped, reverse_mapped, stop_reason, latency_ms, cost_amount, cost_status
       )
       SELECT tenant_id, $1, $2, $3, $4, 1, $5, $6, $7, $8, 5, $9::numeric, $10::text
       FROM evaluation_runs WHERE id = $1`,
      [
        input.runId,
        input.itemId,
        input.rubricId,
        input.judgeModel,
        input.outcome,
        forward,
        reverse,
        stop,
        input.costAmount,
        input.costStatus,
      ],
    );
  }

  async function report(id: string, caller: Tenant = tenant): Promise<{ status: number; body: ReportBody; text: string }> {
    const response = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/${id}/report`,
      headers: headers(caller),
    });
    return { status: response.statusCode, body: response.json() as ReportBody, text: response.body };
  }

  async function stored(name: string, spec: Seed): Promise<ReportBody> {
    const id = runs.get(name) ?? (await seed(spec));
    runs.set(name, id);
    const read = await report(id);
    expect(read.status, read.text).toBe(200);
    expectNoPlaintext(read.text);
    expectRecommendationShape(read.body);
    return read.body;
  }

  function expectNoPlaintext(text: string): void {
    expect(text).not.toContain(PROMPT);
    expect(text).not.toContain(COMPLETION);
    expect(text).not.toContain('ciphertext');
    expect(text).not.toContain('"prompt"');
    expect(text).not.toContain('"messages"');
    expect(text).not.toContain('"completion"');
  }

  function expectRecommendationShape(body: ReportBody): void {
    const recommendation = body.recommendation;
    expect(recommendation.readOnly).toBe(true);
    expect(recommendation.routingChange).toBe(false);
    expect(body.readOnly).toBe(true);
    expect(body.routingChange).toBe(false);
    expect(recommendation.evidenceIds.runId.length).toBeGreaterThan(0);
    expect(recommendation.sampleCount).toBe(body.samples.validPairs);
    expect(recommendation.exclusionCount).toBe(body.samples.excluded);
    expect(recommendation.totalSamples).toBe(body.samples.total);
    expect(recommendation.qualityCriteria.minimumValidPairs).toBe(20);
    expect(recommendation.qualityCriteria.taskCategory).toBe('general_qa');
    expect(recommendation.uncertainty.method).toBe('wilson_95');
    expect(recommendation.uncertainty.equivalentQuality).toBe(false);
    expect(recommendation.reasonCodes.length).toBeGreaterThan(0);
    expect(recommendation.generatedAt.length).toBeGreaterThan(0);
    expect(recommendation.latency.historical.comparableToEvaluation).toBe(false);
    expect(body.latency.historical.comparableToEvaluation).toBe(false);
    expect(body.latency.note).toBe('historical_latency_is_a_separate_series');
    expect(recommendation.modelVersions).toBeTypeOf('object');
    expect(recommendation.cost.evaluationExpense).toBeTypeOf('object');
  }

  it('counts every valid pair', async () => {
    const body = await stored('all-valid', {
      valid: 3,
      outcome: 'model_b',
      objective: 'pass',
      extraObjective: true,
    });
    expect(body.samples).toMatchObject({ total: 3, validPairs: 3, excluded: 0, exclusionReasons: {} });
    expect(body.quality.objective.challenger.notApplicable).toBe(1);
    expect(body.quality.objective.original.unknown).toBe(1);
    expect(body.quality.objective.challenger.rate).toBe(1);
    expect(body.quality.judge.challengerWins).toBe(3);
    expect(body.reliability).toEqual({ attempted: 3, completed: 3, rate: 1 });
    expect(body.recommendation.evidenceIds.itemIds).toHaveLength(3);
    expect(body.recommendation.evidenceIds.attemptIds).toHaveLength(3);
    logApi('all-valid', body);
  });

  it('counts excluded samples and stored failure reasons', async () => {
    const body = await stored('excluded', { valid: 3, excluded: 2, failedAttempts: 1, outcome: 'model_b', objective: 'pass' });
    expect(body.samples.validPairs).toBe(3);
    expect(body.samples.excluded).toBe(2);
    expect(body.samples.exclusionReasons).toEqual({ provider_error: 1, sample_expired: 1 });
    expect(body.quality.judge.challengerWins).toBe(3);
    expect(body.reliability).toEqual({ attempted: 4, completed: 3, rate: 0.75 });
  });

  it('reports zero valid pairs as inconclusive', async () => {
    const body = await stored('zero', { valid: 0, excluded: 2, outcome: 'none', objective: 'none' });
    expect(body.samples).toMatchObject({ total: 2, validPairs: 0, excluded: 2 });
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toEqual(['zero_valid_pairs']);
    expect(body.quality.judge.challengerWins).toBe(0);
    logApi('zero-valid', body);
  });

  it('keeps a small sample below canary eligibility', async () => {
    const body = await stored('small', { valid: 8, outcome: 'model_b', objective: 'pass' });
    expect(body.recommendation.sampleCount).toBe(8);
    expect(body.recommendation.uncertainty.judge?.lower).toBeGreaterThan(0.5);
    expect(body.recommendation.state).toBe('promising');
    expect(body.recommendation.reasonCodes).toContain('below_minimum_sample');
    expect(body.recommendation.reasonCodes).toContain('interval_favors_challenger');
    expect(body.recommendation.state).not.toBe('eligible_for_canary');
    logApi('small-sample', body);
  });

  it('stays inconclusive when judge wins have no pass or fail result', async () => {
    const absent = await stored('judge-only-20', { valid: 20, outcome: 'model_b', objective: 'none' });
    expect(absent.quality.judge.challengerWins).toBe(20);
    expect(absent.quality.objective.challenger.pass).toBe(0);
    expect(absent.quality.objective.challenger.fail).toBe(0);
    expect(absent.quality.objective.challenger.rate).toBeNull();
    expect(absent.recommendation.qualityCriteria.gate).toBe('not_applicable');
    expect(absent.recommendation.uncertainty.direction).toBe('favors_challenger');
    expect(absent.recommendation.state).toBe('inconclusive');
    expect(absent.recommendation.reasonCodes).toEqual(['quality_gate_not_applicable']);
    logApi('judge-only-20', absent);

    const unmarked = await stored('judge-only-8', { valid: 8, outcome: 'model_b', objective: 'none' });
    expect(unmarked.recommendation.uncertainty.judge?.lower).toBeGreaterThan(0.5);
    expect(unmarked.recommendation.state).toBe('inconclusive');
    expect(unmarked.recommendation.reasonCodes).toEqual(['quality_gate_not_applicable']);
    logApi('judge-only-8', unmarked);
  });

  it('stays inconclusive when every objective result is not applicable', async () => {
    const wide = await stored('not-applicable-20', { valid: 20, outcome: 'model_b', objective: 'not_applicable' });
    expect(wide.quality.objective.challenger.notApplicable).toBe(20);
    expect(wide.quality.objective.challenger.pass).toBe(0);
    expect(wide.quality.objective.challenger.fail).toBe(0);
    expect(wide.quality.objective.challenger.rate).toBeNull();
    expect(wide.recommendation.qualityCriteria.gate).toBe('not_applicable');
    expect(wide.recommendation.state).toBe('inconclusive');
    expect(wide.recommendation.reasonCodes).toEqual(['quality_gate_not_applicable']);
    logApi('not-applicable-20', wide);

    const narrow = await stored('not-applicable-8', { valid: 8, outcome: 'model_b', objective: 'not_applicable' });
    expect(narrow.quality.objective.challenger.notApplicable).toBe(8);
    expect(narrow.recommendation.uncertainty.judge?.lower).toBeGreaterThan(0.5);
    expect(narrow.recommendation.state).toBe('inconclusive');
    expect(narrow.recommendation.reasonCodes).toEqual(['quality_gate_not_applicable']);
    logApi('not-applicable-8', narrow);
  });

  it('does not pool mixed task categories into one quality rate', async () => {
    const body = await stored('mixed-task', { valid: 3, outcome: 'model_b', objective: 'pass', mixTask: true });
    expect(body.quality.comparable).toBe(false);
    expect(body.quality.incomparableReasons).toContain('mixed_task_category');
    expect(body.quality.objective.challenger.rate).toBeNull();
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toContain('mixed_task_category');
    expect(body.recommendation.limitations).toContain('quality_not_pooled');
  });

  it('does not pool different evaluation profiles', async () => {
    const body = await stored('mixed-profile', { valid: 3, outcome: 'model_b', objective: 'pass', mixProfile: true });
    expect(body.quality.comparable).toBe(false);
    expect(body.quality.objective.challenger.rate).toBeNull();
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toContain('mixed_profile');
  });

  it('does not pool different rubric versions', async () => {
    const body = await stored('mixed-rubric', { valid: 3, outcome: 'model_b', objective: 'pass', mixRubric: true });
    expect(body.quality.comparable).toBe(false);
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toContain('mixed_rubric_version');
    expect(body.quality.objective.challenger.rate).toBeNull();
  });

  it('treats missing quality results as inconclusive', async () => {
    const body = await stored('missing-quality', { valid: 3, outcome: 'none', objective: 'none' });
    expect(body.samples.validPairs).toBe(3);
    expect(body.quality.judge.challengerWins).toBe(0);
    expect(body.quality.objective.challenger.rate).toBeNull();
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toEqual(['missing_quality']);
  });

  it('does not count inconclusive judgments as wins', async () => {
    const body = await stored('inconclusive', { valid: 3, outcome: 'inconclusive', objective: 'none' });
    expect(body.quality.judge).toMatchObject({ originalWins: 0, challengerWins: 0, inconclusive: 3 });
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toEqual(['all_inconclusive']);
  });

  it('does not count judge position disagreement as a win', async () => {
    const body = await stored('unstable', { valid: 3, outcome: 'unstable', objective: 'none' });
    expect(body.quality.judge).toMatchObject({ originalWins: 0, challengerWins: 0, unstable: 3 });
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toEqual(['judge_disagreement']);
  });

  it('keeps a missing cost missing', async () => {
    const body = await stored('missing-cost', {
      valid: 3,
      outcome: 'model_b',
      objective: 'pass',
      cost: { amount: null, status: null },
    });
    expect(body.cost.challenger.total).toBeNull();
    expect(body.cost.challenger.missing).toBe(3);
    expect(body.cost.evaluationExpense).toEqual({ amount: null, status: 'missing' });
    logApi('missing-cost', body);
    expect(body.cost.challengerAttempts.every((row) => row.amount === null)).toBe(true);
    expect(body.recommendation.cost.evaluationExpense.amount).toBeNull();
    expect(JSON.stringify(body.cost)).not.toContain('"total":"0"');
    expect(JSON.stringify(body.cost)).not.toContain('"amount":"0"');
  });

  it('keeps a provisional expense provisional', async () => {
    const body = await stored('provisional', {
      valid: 3,
      outcome: 'model_b',
      objective: 'pass',
      cost: { amount: '0.02', status: 'provisional' },
    });
    expect(body.cost.evaluationExpense.status).toBe('provisional');
    expect(body.cost.evaluationExpense.amount).not.toBeNull();
    expect(body.cost.challenger.status).toBe('provisional');
    expect(Number(body.cost.evaluationExpense.amount)).toBeGreaterThan(0);
  });

  it('does not pool different model configurations', async () => {
    const body = await stored('mixed-config', { valid: 2, outcome: 'model_b', objective: 'pass', adapterSplit: true });
    expect(body.recommendation.modelVersions.adapterVersions).toEqual([1, 2]);
    expect(body.quality.comparable).toBe(false);
    expect(body.quality.objective.challenger.rate).toBeNull();
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toContain('mixed_model_configuration');
  });

  it('blocks a challenger that misses the quality gate', async () => {
    const body = await stored('gate-fail', {
      valid: 4,
      outcome: 'model_b',
      objective: 'fail_challenger',
      latencyMs: 10,
      historicalMs: 400,
    });
    expect(body.quality.objective.challenger.rate).toBe(0);
    expect(body.recommendation.qualityCriteria.gate).toBe('fail');
    expect(body.recommendation.state).toBe('blocked');
    expect(body.recommendation.reasonCodes).toEqual(['quality_gate_failed']);
    logApi('quality-gate-failure', body);
    expect(body.latency.evaluation.medianMs).toBeLessThan(body.latency.historical.medianMs ?? 0);
  });

  it('recommends canary consideration when the gate and the interval agree', async () => {
    const body = await stored('favor-b', {
      valid: 20,
      outcome: 'model_b',
      objective: 'pass',
      judgeModel: JUDGE_MODEL,
      challengerModel: LONG_MODEL,
      latencyMs: 90,
      historicalMs: 120,
      cost: { amount: '0.004', status: 'reconciled' },
      originalCost: { amount: '0.004', status: 'reconciled' },
    });
    expect(body.recommendation.state).toBe('eligible_for_canary');
    expect(body.recommendation.qualityCriteria.gate).toBe('pass');
    expect(body.recommendation.sampleCount).toBe(20);
    expect(body.recommendation.uncertainty.direction).toBe('favors_challenger');
    expect(body.recommendation.uncertainty.judge?.successes).toBe(20);
    expect(body.recommendation.uncertainty.judge?.trials).toBe(20);
    expect(body.recommendation.uncertainty.judge?.lower).toBeGreaterThan(0.83);
    expect(body.recommendation.uncertainty.judge?.lower).toBeLessThan(0.85);
    expect(body.recommendation.uncertainty.equivalentQuality).toBe(false);
    expect(body.models.challengerModels).toEqual([LONG_MODEL]);
    expect(body.models.judgeModels).toEqual([JUDGE_MODEL]);
    expect(body.recommendation.modelVersions.challengerModels).toContain(LONG_MODEL);
    expect(body.recommendation.modelVersions.judgeModels).toContain(JUDGE_MODEL);
    expect(body.recommendation.profileVersion?.id).toBe(profile.versionId);
    expect(body.recommendation.reasonCodes).toEqual(['interval_favors_challenger', 'quality_gate_passed']);
    console.log(
      `STATS favor-b lower=${body.recommendation.uncertainty.judge?.lower} upper=${body.recommendation.uncertainty.judge?.upper} state=${body.recommendation.state}`,
    );
    logApi('favor-b', body);
  });

  it('keeps a slower and cheaper challenger eligible when quality holds', async () => {
    const body = await stored('slower-cheaper', {
      valid: 20,
      outcome: 'model_b',
      objective: 'pass',
      latencyMs: 800,
      historicalMs: 40,
      cost: { amount: '0.001', status: 'reconciled' },
      originalCost: { amount: '0.05', status: 'reconciled' },
    });
    expect(body.latency.evaluation.medianMs).toBe(800);
    expect(body.latency.historical.medianMs).toBe(40);
    expect(body.latency.evaluation.p95Ms).toBe(800);
    expect(Number(body.cost.challenger.total)).toBeLessThan(Number(body.cost.original.total));
    expect(body.recommendation.state).toBe('eligible_for_canary');
    expect(body.recommendation.latency.evaluation.medianMs).toBe(800);
    expect(body.recommendation.latency.historical.medianMs).toBe(40);
    expect(body.recommendation.cost.challenger.total).not.toBeNull();
  });

  it('does not recommend canary for a faster model that misses the quality gate', async () => {
    const body = await stored('faster-lower', {
      valid: 4,
      outcome: 'model_b',
      objective: 'fail_challenger',
      latencyMs: 15,
      historicalMs: 500,
    });
    expect(body.latency.evaluation.medianMs).toBeLessThan(body.latency.historical.medianMs ?? 0);
    expect(body.recommendation.state).toBe('blocked');
    expect(body.recommendation.reasonCodes).toContain('quality_gate_failed');
  });

  it('recommends retaining the original when the evidence favors model A', async () => {
    const body = await stored('favor-a', { valid: 20, outcome: 'model_a', objective: 'pass' });
    expect(body.quality.judge.originalWins).toBe(20);
    expect(body.quality.judge.challengerWins).toBe(0);
    expect(body.recommendation.uncertainty.judge?.upper).toBeLessThan(0.5);
    expect(body.recommendation.state).toBe('retain_current');
    expect(body.recommendation.reasonCodes).toEqual(['favors_original']);
    console.log(
      `STATS favor-a lower=${body.recommendation.uncertainty.judge?.lower} upper=${body.recommendation.uncertainty.judge?.upper} state=${body.recommendation.state}`,
    );
    logApi('favor-a', body);
  });

  it('does not call a tie equal quality', async () => {
    const body = await stored('tie', { valid: 20, outcome: 'tie', objective: 'pass' });
    expect(body.quality.judge.ties).toBe(20);
    expect(body.quality.judge.challengerWins).toBe(0);
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toContain('tie');
    expect(body.recommendation.reasonCodes).toContain('not_equivalent_quality');
    expect(body.recommendation.uncertainty.equivalentQuality).toBe(false);
    expect(body.recommendation.uncertainty.direction).not.toBe('favors_challenger');
    expect(body.recommendation.reasonCodes).not.toContain('equal_quality');
    expect(body.recommendation.limitations).toContain('difference_is_not_equal_quality');
    console.log(`STATS tie direction=${body.recommendation.uncertainty.direction} state=${body.recommendation.state}`);
    logApi('tie', body);
  });

  it('stays inconclusive when the evidence is insufficient', async () => {
    const body = await stored('insufficient', { valid: 2, outcome: 'model_b', objective: 'pass' });
    expect(body.recommendation.sampleCount).toBe(2);
    expect(body.recommendation.uncertainty.judge?.lower).toBeLessThan(0.5);
    expect(body.recommendation.uncertainty.judge?.lower).toBeGreaterThan(0.3);
    expect(body.recommendation.state).toBe('inconclusive');
    expect(body.recommendation.reasonCodes).toContain('difference_not_significant');
    expect(body.recommendation.reasonCodes).toContain('not_equivalent_quality');
    expect(body.recommendation.uncertainty.equivalentQuality).toBe(false);
    console.log(
      `STATS insufficient lower=${body.recommendation.uncertainty.judge?.lower} upper=${body.recommendation.uncertainty.judge?.upper} state=${body.recommendation.state}`,
    );
    logApi('insufficient', body);
  });

  it('returns only the caller tenant and an empty page for another tenant filter', async () => {
    const owned = runs.get('favor-b');
    if (owned === undefined) throw new Error('favor-b run was not stored');
    const hidden = await report(owned, other);
    expect(hidden.status).toBe(404);
    const foreignList = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations/recommendations',
      headers: headers(other),
    });
    expect(foreignList.statusCode).toBe(200);
    const foreignBody = foreignList.json() as { recommendations: Array<{ evaluationId: string }> };
    expect(foreignBody.recommendations.map((row) => row.evaluationId)).not.toContain(owned);
    const filtered = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/recommendations?tenantId=${other.tenantId}`,
      headers: headers(tenant),
    });
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json()).toEqual({ recommendations: [], nextCursor: null });
    const own = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/recommendations?tenantId=${tenant.tenantId}&limit=50`,
      headers: headers(tenant),
    });
    expect(own.statusCode).toBe(200);
    const ownBody = own.json() as { recommendations: ReportBody['recommendation'][] };
    expect(ownBody.recommendations.map((row) => row.evaluationId)).toContain(owned);
    const listed = ownBody.recommendations.find((row) => row.evaluationId === owned);
    expect(listed?.state).toBe('eligible_for_canary');
    expect(listed?.evidenceIds.runId).toBe(owned);
    expectNoPlaintext(own.body);
  });

  it('does not change a routing alias or a fallback policy', async () => {
    const before = await routingSnapshot();
    const id = runs.get('favor-b');
    if (id === undefined) throw new Error('favor-b run was not stored');
    expect((await report(id)).status).toBe(200);
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations/recommendations?limit=5',
      headers: headers(tenant),
    });
    expect(list.statusCode).toBe(200);
    expect(await routingSnapshot()).toEqual(before);
  });

  it('returns the same counts and recommendation on a second read', async () => {
    const id = runs.get('favor-b');
    if (id === undefined) throw new Error('favor-b run was not stored');
    const first = await report(id);
    const second = await report(id);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const left = stripTime(first.body);
    const right = stripTime(second.body);
    expect(right).toEqual(left);
    expect(first.body.recommendation.state).toBe('eligible_for_canary');
    expect(second.body.recommendation.sampleCount).toBe(first.body.recommendation.sampleCount);
  });

  it('pages recommendations and omits a run that is not finished', async () => {
    const queued = await seed({ valid: 1, finish: false, outcome: 'none', objective: 'none' });
    const open = await report(queued);
    expect(open.status).toBe(200);
    expect(open.body.recommendation.state).toBe('inconclusive');
    expect(open.body.recommendation.reasonCodes).toEqual(['run_not_completed']);
    const first = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations/recommendations?limit=1',
      headers: headers(tenant),
    });
    expect(first.statusCode).toBe(200);
    const page = first.json() as { recommendations: Array<{ evaluationId: string }>; nextCursor: string | null };
    expect(page.recommendations).toHaveLength(1);
    expect(page.nextCursor).toMatch(/^[0-9a-f-]{36}$/);
    const second = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/evaluations/recommendations?limit=50&cursor=${page.nextCursor}`,
      headers: headers(tenant),
    });
    expect(second.statusCode).toBe(200);
    const rest = second.json() as { recommendations: Array<{ evaluationId: string }> };
    const ids = [...page.recommendations, ...rest.recommendations].map((row) => row.evaluationId);
    expect(ids).not.toContain(queued);
    expect(new Set(ids).size).toBe(ids.length);
    const tooBig = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/evaluations/recommendations?limit=51',
      headers: headers(tenant),
    });
    expect(tooBig.statusCode).toBe(400);
  });

  it('boots the real API twice against one completed evaluation', async () => {
    const id = runs.get('favor-b');
    if (id === undefined) throw new Error('favor-b run was not stored');
    const before = await routingSnapshot();
    const first = await bootRead(id);
    const second = await bootRead(id);
    expect(second.signature).toEqual(first.signature);
    expect(first.signature.state).toBe('eligible_for_canary');
    expect(first.signature.evidenceRunId.length).toBeGreaterThan(0);
    expect(first.signature.sampleCount).toBe(20);
    expect(first.signature.readOnly).toBe(true);
    expect(first.signature.routingChange).toBe(false);
    expect(first.signature.profileVersionId.length).toBeGreaterThan(0);
    expect(first.signature.reasonCodes).toEqual(['interval_favors_challenger', 'quality_gate_passed']);
    expect(first.text).not.toContain(PROMPT);
    expect(first.text).not.toContain(COMPLETION);
    expect(second.text).not.toContain(PROMPT);
    expect(second.text).not.toContain(COMPLETION);
    expect(first.listState).toBe('eligible_for_canary');
    expect(second.listState).toBe(first.listState);
    expect(await routingSnapshot()).toEqual(before);
    console.log(JSON.stringify({ step: 'launch-1', port: first.port, runId: id, signature: first.signature, listState: first.listState }));
    console.log(JSON.stringify({ step: 'launch-2', port: second.port, runId: id, signature: second.signature, listState: second.listState }));
    console.log(JSON.stringify({ step: 'compare', same: true, state: first.signature.state, sampleCount: first.signature.sampleCount }));
  });

  async function bootRead(id: string): Promise<{
    port: number;
    text: string;
    listState: string;
    signature: Record<string, unknown>;
  }> {
    const port = await freePort();
    const child = spawnServer(serviceEnv(db, { PORT: String(port), LOG_LEVEL: 'info' }));
    try {
      await waitForReady(port);
      expect(child.output()).not.toContain('evaluation-worker');
      const response = await fetch(`http://127.0.0.1:${port}/internal/v1/evaluations/${id}/report`, {
        headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` },
      });
      const text = await response.text();
      expect(response.status, text).toBe(200);
      const body = JSON.parse(text) as ReportBody;
      const listed = await fetch(
        `http://127.0.0.1:${port}/internal/v1/evaluations/recommendations?tenantId=${tenant.tenantId}&limit=50`,
        { headers: { 'x-tenant-id': tenant.tenantId, authorization: `Bearer ${tenant.secret}` } },
      );
      const listText = await listed.text();
      expect(listed.status, listText).toBe(200);
      const list = JSON.parse(listText) as { recommendations: ReportBody['recommendation'][] };
      const match = list.recommendations.find((row) => row.evaluationId === id);
      expect(match?.state).toBe(body.recommendation.state);
      return {
        port,
        text,
        listState: match?.state ?? '',
        signature: {
          state: body.recommendation.state,
          readOnly: body.recommendation.readOnly,
          routingChange: body.recommendation.routingChange,
          evidenceRunId: body.recommendation.evidenceIds.runId,
          profileVersionId: body.recommendation.profileVersion?.id ?? '',
          sampleCount: body.recommendation.sampleCount,
          totalSamples: body.recommendation.totalSamples,
          exclusionCount: body.recommendation.exclusionCount,
          validPairs: body.samples.validPairs,
          excluded: body.samples.excluded,
          gate: body.recommendation.qualityCriteria.gate,
          direction: body.recommendation.uncertainty.direction,
          equivalentQuality: body.recommendation.uncertainty.equivalentQuality,
          reasonCodes: body.recommendation.reasonCodes,
          challengerWins: body.quality.judge.challengerWins,
          originalWins: body.quality.judge.originalWins,
          expenseStatus: body.cost.evaluationExpense.status,
          expenseAmount: body.cost.evaluationExpense.amount,
          evaluationMedianMs: body.latency.evaluation.medianMs,
          historicalMedianMs: body.latency.historical.medianMs,
          historicalComparable: body.latency.historical.comparableToEvaluation,
          reliability: body.reliability.rate,
          challengerModel: body.models.challengerModels[0] ?? '',
          judgeModel: body.models.judgeModels[0] ?? '',
        },
      };
    } finally {
      await stopChild(child.child);
    }
  }

  async function routingSnapshot(): Promise<{ aliases: number; policies: number; version: number }> {
    const aliases = await admin.query<{ count: number }>(`SELECT count(*)::int AS count FROM model_aliases`);
    const policies = await admin.query<{ count: number; version: number }>(
      `SELECT count(*)::int AS count, coalesce(max(policy_version), 0)::int AS version FROM fallback_policies`,
    );
    return {
      aliases: aliases.rows[0]?.count ?? -1,
      policies: policies.rows[0]?.count ?? -1,
      version: policies.rows[0]?.version ?? -1,
    };
  }
});

function logApi(name: string, body: ReportBody): void {
  const report = {
    samples: body.samples,
    quality: body.quality,
    cost: {
      original: body.cost.original,
      challenger: body.cost.challenger,
      judge: body.cost.judge,
      evaluationExpense: body.cost.evaluationExpense,
    },
    latency: body.latency,
    reliability: body.reliability,
    models: body.models,
    recommendation: body.recommendation,
    readOnly: body.readOnly,
    routingChange: body.routingChange,
  };
  console.log(`API ${name} ${JSON.stringify(report)}`);
}

function stripTime(body: ReportBody): unknown {
  const clone = structuredClone(body);
  clone.generatedAt = '';
  clone.recommendation.generatedAt = '';
  return clone;
}
