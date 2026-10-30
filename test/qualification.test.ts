import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { criteriaForCategory } from '../src/inference/judge.js';
import {
  qualifyCohort,
  type QualificationItem,
  type QualificationProfile,
} from '../src/inference/qualification.js';
import { createTestApp, loadTestDatabase, runCli, type TestDatabase } from './helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKey, provisionTenant, registerInference } from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';

const PROMPT = 'qual-slice-08b-prompt-token';
const NOW = new Date('2026-06-01T00:00:00.000Z');
const OUTPUT = '00000000-0000-4000-8000-000000000010';

// Wilson 95 percent bounds and Newcombe method 10 difference bounds.
// Computed with Z = 1.96 and half-up rounding to 6 decimals. These literals
// are not produced by calling qualifyCohort.
const QUALIFIED_BOUNDS = { lower: 0.83887, upper: 1, differenceLower: -0.16113 };
const THRESHOLD_BOUNDS = { lower: 0.299295, upper: 0.700705, differenceLower: -0.613274 };
const WIDE_BOUNDS = { lower: 0.675584, upper: 1, differenceLower: -0.324416 };
const NONINFERIOR_BOUNDS = { lower: 0.698962, upper: 0.972134, differenceLower: -0.301038 };

// Each negative cohort uses its own challenger deployment. The loader reads
// every completed run for the profile deployment, so a shared name would pool
// later cases into the qualified 20/20 cohort.
const DEPLOYMENT_BY_CASE: Record<string, string> = {
  'threshold-failed': 'qual-threshold',
  'too-few': 'qual-few',
  'wide-interval': 'qual-wide',
  noninferiority: 'qual-inferior',
  'judge-inconclusive': 'qual-judge',
  'order-bias': 'qual-bias',
  'wrong-task': 'qual-task',
  'short-input': 'qual-short',
  'old-model': 'qual-old',
  adapter: 'qual-adapter',
  'unknown-cost': 'qual-cost',
  'missing-latency': 'qual-latency',
  expired: 'qual-expired',
  contradictory: 'qual-contra',
  'cheap-unknown': 'qual-cheap',
  'wrong-output': 'qual-output',
};
const CASE_DEPLOYMENTS = Object.values(DEPLOYMENT_BY_CASE);

function profile(overrides: Partial<QualificationProfile> = {}): QualificationProfile {
  return {
    taskCategory: 'extraction',
    complexity: 'low',
    inputSizeCategory: 'l',
    outputRequirementId: OUTPUT,
    requiredCapabilities: ['temperature'],
    candidateDeploymentName: 'qual-chat',
    modelVersion: 'gpt-model-b',
    deploymentConfigVersion: 1,
    adapterVersion: 1,
    minSamples: 20,
    objectiveFloor: 0.8,
    maxIntervalWidth: 0.2,
    noninferiorityMargin: 0.2,
    freshnessSeconds: 86_400,
    minCoverage: 1,
    ...overrides,
  };
}

function item(overrides: Partial<QualificationItem> = {}): QualificationItem {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    runUpdatedAt: NOW,
    runStatus: 'completed',
    profileApproved: true,
    runTaskCategory: 'extraction',
    runProfileVersionId: OUTPUT,
    sampleTaskCategory: 'extraction',
    complexity: 'low',
    inputSize: 1000,
    requiredCapabilities: ['temperature'],
    challengerDeploymentName: 'qual-chat',
    challengerModel: 'gpt-model-b',
    configVersion: 1,
    adapterVersion: 1,
    attemptStatus: 'completed',
    originalPresent: true,
    challengerLatencyMs: 80,
    originalDurationMs: 100,
    challengerCostAmount: '0.01',
    challengerCostStatus: 'reconciled',
    originalCostAmount: '0.01',
    originalCostStatus: 'reconciled',
    challengerResults: ['pass'],
    originalResults: ['pass'],
    judgeOutcome: null,
    forwardMapped: null,
    reverseMapped: null,
    ...overrides,
  };
}

function cohort(count: number, challengerPasses: number, originalPasses: number, overrides: Partial<QualificationItem> = {}): QualificationItem[] {
  return Array.from({ length: count }, (_, index) =>
    item({
      challengerResults: [index < challengerPasses ? 'pass' : 'fail'],
      originalResults: [index < originalPasses ? 'pass' : 'fail'],
      ...overrides,
    }),
  );
}

describe('qualification decision', () => {
  it('qualifies a cohort only when the uncertainty bounds clear every numeric gate', () => {
    const qualified = qualifyCohort(profile(), cohort(20, 20, 20), NOW);
    expect(qualified.status).toBe('qualified');
    expect(qualified.reasonCodes).toEqual([]);
    expect(qualified.uncertainty).toEqual({ method: 'wilson_95_newcombe', ...QUALIFIED_BOUNDS });
    expect(qualified.sampleCount).toBe(20);
    expect(qualified.coverageRate).toBe(1);

    const failed = qualifyCohort(profile({ maxIntervalWidth: 0.5 }), cohort(20, 10, 18), NOW);
    expect(failed.status).toBe('unqualified');
    expect(failed.reasonCodes).toEqual(['objective_threshold_failed']);
    expect(failed.uncertainty).toEqual({ method: 'wilson_95_newcombe', ...THRESHOLD_BOUNDS });

    const wide = qualifyCohort(
      profile({ minSamples: 8, objectiveFloor: 0.6, maxIntervalWidth: 0.2, noninferiorityMargin: 0.4 }),
      cohort(8, 8, 8),
      NOW,
    );
    expect(wide.status).toBe('inconclusive');
    expect(wide.reasonCodes).toEqual(['uncertainty_too_wide']);
    expect(wide.uncertainty).toEqual({ method: 'wilson_95_newcombe', ...WIDE_BOUNDS });
    expect(wide.challengerPasses / wide.challengerTrials).toBe(1);

    const inferior = qualifyCohort(
      profile({ objectiveFloor: 0.65, maxIntervalWidth: 0.3, noninferiorityMargin: 0.1 }),
      cohort(20, 18, 20),
      NOW,
    );
    expect(inferior.status).toBe('unqualified');
    expect(inferior.reasonCodes).toEqual(['noninferiority_failed']);
    expect(inferior.uncertainty).toEqual({ method: 'wilson_95_newcombe', ...NONINFERIOR_BOUNDS });
  });

  it('rejects stale, biased, cheap, and incomparable evidence', () => {
    expect(qualifyCohort(profile(), cohort(5, 5, 5), NOW)).toMatchObject({
      status: 'inconclusive',
      reasonCodes: ['insufficient_samples'],
    });
    expect(
      qualifyCohort(
        profile({ minSamples: 1, objectiveFloor: 0.01, maxIntervalWidth: 0.99, noninferiorityMargin: 0.99 }),
        [item({ judgeOutcome: 'inconclusive', forwardMapped: null, reverseMapped: null })],
        NOW,
      ),
    ).toMatchObject({ status: 'inconclusive', reasonCodes: ['judge_inconclusive'] });
    expect(
      qualifyCohort(
        profile({ minSamples: 1 }),
        [item({ judgeOutcome: 'unstable', forwardMapped: 'original', reverseMapped: 'challenger' })],
        NOW,
      ),
    ).toMatchObject({ status: 'invalidated', reasonCodes: ['judge_order_bias'] });
    expect(qualifyCohort(profile({ minSamples: 1 }), [item({ runTaskCategory: 'coding', sampleTaskCategory: 'coding' })], NOW)).toMatchObject({
      status: 'invalidated',
      reasonCodes: ['wrong_task'],
    });
    expect(qualifyCohort(profile({ minSamples: 1 }), [item({ requiredCapabilities: null })], NOW)).toMatchObject({
      status: 'invalidated',
      reasonCodes: ['capability_mismatch'],
    });
    expect(qualifyCohort(profile({ minSamples: 1 }), [item({ inputSize: 64 })], NOW)).toMatchObject({
      status: 'invalidated',
      reasonCodes: ['input_size_mismatch'],
      coverageRate: 0,
    });
    expect(qualifyCohort(profile({ minSamples: 1 }), [item({ challengerModel: 'gpt-model-old' })], NOW)).toMatchObject({
      status: 'invalidated',
      reasonCodes: ['model_version_mismatch'],
    });
    expect(qualifyCohort(profile({ minSamples: 1 }), [item({ adapterVersion: 2 })], NOW)).toMatchObject({
      status: 'invalidated',
      reasonCodes: ['adapter_version_mismatch'],
    });
    expect(
      qualifyCohort(profile({ minSamples: 1 }), [item({ challengerCostStatus: 'unknown', challengerCostAmount: null })], NOW),
    ).toMatchObject({ status: 'inconclusive', reasonCodes: ['unknown_cost'] });
    expect(qualifyCohort(profile({ minSamples: 1 }), [item({ challengerLatencyMs: null })], NOW)).toMatchObject({
      status: 'inconclusive',
      reasonCodes: ['missing_latency'],
    });
    expect(
      qualifyCohort(
        profile({ minSamples: 1, freshnessSeconds: 7 * 86_400 }),
        [item({ runUpdatedAt: new Date(NOW.getTime() - 40 * 86_400 * 1000) })],
        NOW,
      ),
    ).toMatchObject({ status: 'invalidated', reasonCodes: ['expired_evidence'] });
    expect(
      qualifyCohort(profile({ minSamples: 1 }), [item({ challengerResults: ['pass', 'fail'] })], NOW),
    ).toMatchObject({ status: 'invalidated', reasonCodes: ['contradictory_findings'] });
    const cheap = qualifyCohort(
      profile({ minSamples: 1 }),
      [
        item({
          challengerResults: [],
          originalResults: [],
          challengerCostAmount: '0.0001',
          originalCostAmount: '0.0001',
          judgeOutcome: 'model_b',
          forwardMapped: 'challenger',
          reverseMapped: 'challenger',
        }),
      ],
      NOW,
    );
    expect(cheap.status).toBe('inconclusive');
    expect(cheap.reasonCodes).toEqual(['judge_is_not_objective']);
    expect(cheap.status).not.toBe('qualified');
    const judgedFailure = qualifyCohort(
      profile({ minSamples: 1 }),
      [
        item({
          challengerResults: ['fail'],
          originalResults: ['pass'],
          challengerCostAmount: '0.0001',
          judgeOutcome: 'model_b',
          forwardMapped: 'challenger',
          reverseMapped: 'challenger',
        }),
      ],
      NOW,
    );
    expect(judgedFailure.status).toBe('unqualified');
    expect(judgedFailure.reasonCodes).toEqual(['objective_threshold_failed']);
  });
});

type Tenant = { tenantId: string; keyId: string; secret: string; name: string };
type Snapshot = {
  id: string;
  profileVersionId: string;
  taskCategory: string;
  complexity: string;
  inputSizeCategory: string;
  candidateDeployment: string;
  modelVersion: string;
  adapterVersion: number;
  status: string;
  reasonCodes: string[];
  uncertainty: { method: string; lower: number | null; upper: number | null; differenceLower: number | null };
  sourceRunIds: string[];
  sampleCount: number;
  coverageRate: number;
  createdAt: string;
};

describe('evidence qualification engine', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];
  let admin: pg.Pool;
  let app: Awaited<ReturnType<typeof createTestApp>>;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let owner: Tenant;
  let other: Tenant;
  let chatSecret = '';
  let templateId = '';
  let configVersion = 1;
  let outputRequirementId = '';
  let otherRequirementId = '';
  let rubricVersionId = '';
  let names = 0;

  beforeAll(async () => {
    mock = await startMockUpstream();
    owner = provisionTenant(db, 'Qual Owner');
    other = provisionTenant(db, 'Qual Other');
    registerInference(db, {
      tenantId: owner.tenantId,
      apiKey: 'sk-qual-owner',
      deployment: 'qual-chat',
      upstreamModel: 'gpt-baseline',
      capabilities: 'temperature',
    });
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-qual-other',
      deployment: 'qual-other',
      upstreamModel: 'gpt-other',
      capabilities: 'temperature',
    });
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', owner.tenantId, '--deployment', 'qual-chat', '--data-class', 'internal'],
      cliEnv(),
    );
    for (const name of CASE_DEPLOYMENTS) {
      runCli(
        db,
        [
          'register-deployment',
          '--tenant-id',
          owner.tenantId,
          '--name',
          name,
          '--upstream-model',
          'gpt-baseline',
          '--timeout-ms',
          '5000',
          '--capabilities',
          'temperature',
          '--enabled',
          'true',
        ],
        cliEnv(),
      );
      runCli(
        db,
        ['set-deployment-data-class', '--tenant-id', owner.tenantId, '--deployment', name, '--data-class', 'internal'],
        cliEnv(),
      );
    }
    setSamplePolicy(db, owner.tenantId, 'qual-chat');
    const chat = runCli(db, ['add-key', '--tenant-id', owner.tenantId, '--label', 'chat']);
    if (!chat.secret) throw new Error('chat key was not created');
    chatSecret = chat.secret;
    admin = adminPool(db);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [owner.tenantId, owner.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [owner.tenantId, owner.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [other.tenantId, other.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [other.tenantId, other.keyId]);
    app = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    closers.push(async () => {
      await app.app.close();
      await app.authPool.end();
      await app.runtimePool.end();
      await admin.end();
      await mock.close();
    });
    templateId = await capture();
    const version = await admin.query<{ deployment_config_version: number }>(
      `SELECT pr.deployment_config_version
       FROM request_samples s
       JOIN proxy_requests pr ON pr.id = s.request_id
       WHERE s.id = $1`,
      [templateId],
    );
    configVersion = version.rows[0]?.deployment_config_version ?? 1;
    outputRequirementId = (await approveProfile('qual-extract')).versionId;
    otherRequirementId = (await approveProfile('qual-other-profile')).versionId;
    rubricVersionId = (await approveRubric('qual-rubric')).versionId;
  }, 180_000);

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  function headers(tenant: Tenant, idempotencyKey?: string): Record<string, string> {
    return {
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    };
  }

  async function capture(): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-tenant-id': owner.tenantId, authorization: `Bearer ${chatSecret}`, 'content-type': 'application/json' },
      payload: chatPayload('qual-chat', PROMPT),
    });
    expect(response.statusCode, response.body).toBe(200);
    const stored = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [owner.tenantId],
    );
    const id = stored.rows[0]?.id;
    if (id === undefined) throw new Error('sample was not stored');
    return id;
  }

  async function cloneSample(input: {
    taskCategory: string;
    inputSize: number;
    complexity: string;
    requiredCapabilities: string[] | null;
  }): Promise<string> {
    const source = await admin.query<Record<string, unknown>>(
      `SELECT request_id, tenant_id, policy_id, policy_version, provider, deployment_name, data_classification,
              schema_version, size_bytes, wrapping_key_version, wrapped_key_iv, wrapped_key_tag, wrapped_key_ciphertext,
              content_iv, content_tag, content_ciphertext, slot, text_only, source_location
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
        input.taskCategory,
        input.inputSize,
        input.complexity,
        row.text_only,
        input.requiredCapabilities,
        row.source_location,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('clone was not stored');
    return id;
  }

  async function approveProfile(name: string): Promise<{ versionId: string }> {
    const created = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: headers(owner),
      payload: {
        name,
        taskCategory: 'extraction',
        config: {
          limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 },
          validators: [{ id: 'json_parse', version: 1 }],
        },
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { id: string; version: number; versionId: string };
    const approved = await app.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${body.id}/versions/${body.version}/approve`,
      headers: headers(owner),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return { versionId: body.versionId };
  }

  async function approveRubric(name: string): Promise<{ versionId: string }> {
    const created = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-rubrics',
      headers: headers(owner),
      payload: { name, taskCategory: 'extraction', config: { criteria: criteriaForCategory('extraction') } },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json() as { id: string; version: number; versionId: string };
    const approved = await app.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-rubrics/${body.id}/versions/${body.version}/approve`,
      headers: headers(owner),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return { versionId: body.versionId };
  }

  async function seedRun(input: {
    count: number;
    taskCategory?: string;
    inputSize?: number;
    complexity?: string;
    capabilities?: string[] | null;
    profileVersionId?: string;
    challengerPasses?: number;
    originalPasses?: number;
    challengerModel?: string;
    adapterVersion?: number;
    latencyMs?: number | null;
    costStatus?: string;
    costAmount?: string | null;
    judge?: 'none' | 'inconclusive' | 'bias' | 'challenger';
    contradictory?: boolean;
    objective?: boolean;
    expire?: boolean;
    mixedSize?: boolean;
    deployment?: string;
  }): Promise<string> {
    const deployment = input.deployment ?? 'qual-chat';
    const allowed = deployment === 'qual-chat' ? 'qual-chat' : `qual-chat,${deployment}`;
    setSamplePolicy(db, owner.tenantId, allowed);
    const taskCategory = input.taskCategory ?? 'extraction';
    const sampleIds: string[] = [];
    for (let index = 0; index < input.count; index += 1) {
      sampleIds.push(
        await cloneSample({
          taskCategory,
          inputSize: input.mixedSize === true && index === 1 ? 64 : (input.inputSize ?? 1000),
          complexity: input.complexity ?? 'low',
          requiredCapabilities: input.capabilities === undefined ? ['temperature'] : input.capabilities,
        }),
      );
    }
    names += 1;
    const needsJudge = input.judge !== undefined && input.judge !== 'none';
    const created = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluations',
      headers: headers(owner, `qual-run-${names}-${randomUUID()}`),
      payload: {
        name: `qual-run-${names}`,
        sampleCategory: taskCategory,
        sampleIds,
        challengerDeployment: deployment,
        requiredCapabilities: ['temperature'],
        budgetEstimate: '0.25',
        mode: 'replay',
        profileVersionId: input.profileVersionId ?? outputRequirementId,
        ...(needsJudge ? { judgeDeployment: 'qual-chat', rubricVersionId } : {}),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const runId = (created.json() as { id: string }).id;
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
      const challengerPasses = input.challengerPasses ?? input.count;
      const originalPasses = input.originalPasses ?? input.count;
      for (const [index, row] of items.rows.entries()) {
        await insertOriginal(client, row.request_id);
        await insertAttempt(client, {
          runId,
          itemId: row.id,
          sampleId: row.sample_id,
          latencyMs: input.latencyMs === undefined ? 80 : input.latencyMs,
          costAmount: input.costAmount === undefined ? '0.01000000' : input.costAmount,
          costStatus: input.costStatus ?? 'reconciled',
          adapterVersion: input.adapterVersion ?? 1,
          challengerModel: input.challengerModel ?? 'gpt-model-b',
          deployment,
        });
        if (input.objective !== false) {
          await insertValidator(client, runId, row.id, input.profileVersionId ?? outputRequirementId, 'original', index < originalPasses ? 'pass' : 'fail');
          await insertValidator(
            client,
            runId,
            row.id,
            input.profileVersionId ?? outputRequirementId,
            'challenger',
            index < challengerPasses ? 'pass' : 'fail',
          );
          if (input.contradictory === true && index === 0) {
            await insertValidator(client, runId, row.id, input.profileVersionId ?? outputRequirementId, 'challenger', 'fail', 'required_fields');
          }
        }
        if (needsJudge) {
          await insertFinding(client, owner.tenantId, runId, row.id, rubricVersionId, input.judge ?? 'none');
        }
      }
      await client.query(
        `UPDATE evaluation_items
         SET status = 'completed', reason_code = 'replay_completed', updated_at = now()
         WHERE run_id = $1`,
        [runId],
      );
      await client.query(
        `UPDATE evaluation_runs
         SET status = 'completed', pending_count = 0, queued_count = 0, running_count = 0,
             completed_count = $2, failed_count = 0, cancelled_count = 0,
             updated_at = CASE WHEN $3::boolean THEN now() - interval '40 days' ELSE now() END
         WHERE id = $1`,
        [runId, input.count, input.expire === true],
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

  async function createProfile(input: {
    name: string;
    minSamples: number;
    objectiveFloor: string;
    maxIntervalWidth: string;
    noninferiorityMargin: string;
    taskCategory?: string;
    inputSizeCategory?: string;
    outputRequirementId?: string;
    modelVersion?: string;
    adapterVersion?: number;
    freshnessSeconds?: number;
    requiredCapabilities?: string[];
    candidateDeployment?: string;
  }): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/qualification-profiles',
      headers: headers(owner, `qual-profile-${input.name}`),
      payload: {
        name: input.name,
        taskCategory: input.taskCategory ?? 'extraction',
        complexity: 'low',
        inputSizeCategory: input.inputSizeCategory ?? 'l',
        outputRequirementId: input.outputRequirementId ?? outputRequirementId,
        requiredCapabilities: input.requiredCapabilities ?? ['temperature'],
        candidateDeployment: input.candidateDeployment ?? 'qual-chat',
        modelVersion: input.modelVersion ?? 'gpt-model-b',
        deploymentConfigVersion: configVersion,
        adapterVersion: input.adapterVersion ?? 1,
        minSamples: input.minSamples,
        objectiveFloor: input.objectiveFloor,
        maxIntervalWidth: input.maxIntervalWidth,
        noninferiorityMargin: input.noninferiorityMargin,
        freshnessSeconds: input.freshnessSeconds ?? 2_592_000,
        minCoverage: '1.00000',
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    return (response.json() as { versionId: string }).versionId;
  }

  async function refresh(profileVersionId: string, key: string): Promise<{ statusCode: number; snapshot: Snapshot }> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/evidence/refresh',
      headers: headers(owner, key),
      payload: { profileVersionId },
    });
    return { statusCode: response.statusCode, snapshot: response.json() as Snapshot };
  }

  async function listed(): Promise<Snapshot[]> {
    const response = await app.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/evidence',
      headers: headers(owner),
    });
    expect(response.statusCode, response.body).toBe(200);
    return (response.json() as { snapshots: Snapshot[] }).snapshots;
  }

  it('stores immutable evidence and leaves model=auto on the baseline', async () => {
    const caller = {
      'x-tenant-id': owner.tenantId,
      authorization: `Bearer ${chatSecret}`,
      'content-type': 'application/json',
    };
    const beforeHits = mock.hits.length;
    const beforeChat = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('auto', PROMPT),
    });
    expect(beforeChat.statusCode, beforeChat.body).toBe(200);
    expect(beforeChat.headers['x-deployment']).toBe('qual-chat');
    expect(JSON.parse(mock.hits.at(-1)?.body ?? '{}').model).toBe('gpt-baseline');
    expect(mock.hits.length - beforeHits).toBe(1);
    expect(beforeChat.body).not.toContain('qualified');
    expect(beforeChat.body).not.toContain(PROMPT);

    const qualifiedRun = await seedRun({ count: 20, challengerPasses: 20, originalPasses: 20 });
    const qualifiedVersion = await createProfile({
      name: 'extract-qualified',
      minSamples: 20,
      objectiveFloor: '0.80000',
      maxIntervalWidth: '0.20000',
      noninferiorityMargin: '0.20000',
    });
    const hitsAtRefresh = mock.hits.length;
    const qualified = await refresh(qualifiedVersion, 'qual-refresh-qualified');
    expect(qualified.statusCode, JSON.stringify(qualified.snapshot)).toBe(201);
    expect(mock.hits.length).toBe(hitsAtRefresh);
    expect(qualified.snapshot.status).toBe('qualified');
    expect(qualified.snapshot.reasonCodes).toEqual([]);
    expect(qualified.snapshot.uncertainty).toEqual({ method: 'wilson_95_newcombe', ...QUALIFIED_BOUNDS });
    expect(qualified.snapshot.sampleCount).toBe(20);
    expect(qualified.snapshot.coverageRate).toBe(1);
    expect(qualified.snapshot.taskCategory).toBe('extraction');
    expect(qualified.snapshot.inputSizeCategory).toBe('l');
    expect(qualified.snapshot.candidateDeployment).toBe('qual-chat');
    expect(qualified.snapshot.modelVersion).toBe('gpt-model-b');
    expect(qualified.snapshot.sourceRunIds).toEqual([qualifiedRun]);
    expect(JSON.stringify(qualified.snapshot)).not.toContain(PROMPT);
    expect(JSON.stringify(qualified.snapshot)).not.toContain('eligible_for_canary');
    expect(JSON.stringify(qualified.snapshot)).not.toContain('ciphertext');

    const page = await listed();
    expect(page.map((row) => row.id)).toContain(qualified.snapshot.id);
    console.log(`EVIDENCE evidence-api ${JSON.stringify(qualified.snapshot)}`);
    console.log(
      `EVIDENCE snapshot ${JSON.stringify({ id: qualified.snapshot.id, sourceRunIds: qualified.snapshot.sourceRunIds, status: qualified.snapshot.status, createdAt: qualified.snapshot.createdAt })}`,
    );
    console.log(
      `EVIDENCE coverage ${JSON.stringify({ qualified: qualified.snapshot.coverageRate, sampleCount: qualified.snapshot.sampleCount, inputSizeCategory: 'l' })}`,
    );

    const replay = await refresh(qualifiedVersion, 'qual-refresh-qualified');
    expect(replay.statusCode).toBe(200);
    expect(replay.snapshot.id).toBe(qualified.snapshot.id);

    const afterHits = mock.hits.length;
    const afterChat = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('auto', 'qual-slice-08b-after'),
    });
    expect(afterChat.statusCode, afterChat.body).toBe(200);
    expect(afterChat.headers['x-deployment']).toBe('qual-chat');
    expect(JSON.parse(mock.hits.at(-1)?.body ?? '{}').model).toBe('gpt-baseline');
    expect(mock.hits.length - afterHits).toBe(1);
    expect(afterChat.body).not.toContain('wilson_95_newcombe');
    expect(afterChat.body).not.toContain(qualified.snapshot.id);
    const named = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: caller,
      payload: chatPayload('qual-chat', 'qual-slice-08b-named'),
    });
    expect(named.statusCode).toBe(200);
    expect(named.headers['x-deployment']).toBe('qual-chat');
    console.log(
      `EVIDENCE routing-unchanged ${JSON.stringify({ beforeDeployment: beforeChat.headers['x-deployment'], afterDeployment: afterChat.headers['x-deployment'], upstreamModel: 'gpt-baseline', providerCallsEach: 1, qualificationStatusInChat: false })}`,
    );

    await expectCase('threshold-failed', { count: 20, challengerPasses: 10, originalPasses: 18 }, {
      name: 'extract-threshold',
      minSamples: 20,
      objectiveFloor: '0.80000',
      maxIntervalWidth: '0.50000',
      noninferiorityMargin: '0.20000',
    }, { status: 'unqualified', reasonCodes: ['objective_threshold_failed'], uncertainty: THRESHOLD_BOUNDS });

    await expectCase('too-few', { count: 5, challengerPasses: 5, originalPasses: 5 }, {
      name: 'extract-few',
      minSamples: 20,
      objectiveFloor: '0.80000',
      maxIntervalWidth: '0.20000',
      noninferiorityMargin: '0.20000',
    }, { status: 'inconclusive', reasonCodes: ['insufficient_samples'] });

    await expectCase('wide-interval', { count: 8, challengerPasses: 8, originalPasses: 8 }, {
      name: 'extract-wide',
      minSamples: 8,
      objectiveFloor: '0.60000',
      maxIntervalWidth: '0.20000',
      noninferiorityMargin: '0.40000',
    }, { status: 'inconclusive', reasonCodes: ['uncertainty_too_wide'], uncertainty: WIDE_BOUNDS });

    await expectCase('noninferiority', { count: 20, challengerPasses: 18, originalPasses: 20 }, {
      name: 'extract-inferior',
      minSamples: 20,
      objectiveFloor: '0.65000',
      maxIntervalWidth: '0.30000',
      noninferiorityMargin: '0.10000',
    }, { status: 'unqualified', reasonCodes: ['noninferiority_failed'], uncertainty: NONINFERIOR_BOUNDS });

    await expectCase('judge-inconclusive', { count: 20, challengerPasses: 20, originalPasses: 20, judge: 'inconclusive' }, {
      name: 'extract-judge',
      minSamples: 20,
      objectiveFloor: '0.80000',
      maxIntervalWidth: '0.20000',
      noninferiorityMargin: '0.20000',
    }, { status: 'inconclusive', reasonCodes: ['judge_inconclusive'] });

    await expectCase('order-bias', { count: 1, judge: 'bias' }, {
      name: 'extract-bias',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'invalidated', reasonCodes: ['judge_order_bias'] });

    await expectCase('wrong-task', { count: 1, taskCategory: 'coding' }, {
      name: 'extract-wrong-task',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'invalidated', reasonCodes: ['wrong_task'] });

    const short = await expectCase('short-input', { count: 1, inputSize: 64 }, {
      name: 'extract-short',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
      inputSizeCategory: 'l',
    }, { status: 'invalidated', reasonCodes: ['input_size_mismatch'] });
    expect(short.coverageRate).toBe(0);
    console.log(`EVIDENCE coverage-short ${JSON.stringify({ status: short.status, coverageRate: short.coverageRate, inputSizeCategory: short.inputSizeCategory })}`);

    await expectCase('old-model', { count: 1, challengerModel: 'gpt-model-old' }, {
      name: 'extract-old-model',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'invalidated', reasonCodes: ['model_version_mismatch'] });

    await expectCase('adapter', { count: 1, adapterVersion: 2 }, {
      name: 'extract-adapter',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'invalidated', reasonCodes: ['adapter_version_mismatch'] });

    await expectCase('unknown-cost', { count: 1, costStatus: 'unknown', costAmount: null }, {
      name: 'extract-cost',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'inconclusive', reasonCodes: ['unknown_cost'] });

    await expectCase('missing-latency', { count: 1, latencyMs: null }, {
      name: 'extract-latency',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'inconclusive', reasonCodes: ['missing_latency'] });

    await expectCase('expired', { count: 1, expire: true }, {
      name: 'extract-expired',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
      freshnessSeconds: 604_800,
    }, { status: 'invalidated', reasonCodes: ['expired_evidence'] });

    await expectCase('contradictory', { count: 1, contradictory: true }, {
      name: 'extract-contradictory',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'invalidated', reasonCodes: ['contradictory_findings'] });

    await expectCase('cheap-unknown', { count: 1, objective: false, judge: 'challenger', costAmount: '0.00010000' }, {
      name: 'extract-cheap',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'inconclusive', reasonCodes: ['judge_is_not_objective'] });

    await expectCase('wrong-output', { count: 1, profileVersionId: otherRequirementId }, {
      name: 'extract-output',
      minSamples: 1,
      objectiveFloor: '0.50000',
      maxIntervalWidth: '0.90000',
      noninferiorityMargin: '0.90000',
    }, { status: 'invalidated', reasonCodes: ['output_requirement_mismatch'] });

    const hidden = await app.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/evidence',
      headers: headers(other),
    });
    expect(hidden.statusCode).toBe(200);
    expect(hidden.json()).toEqual({ snapshots: [] });
    const filtered = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/evidence?tenantId=${owner.tenantId}`,
      headers: headers(other),
    });
    expect(filtered.json()).toEqual({ snapshots: [] });
    const missing = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/evidence/refresh',
      headers: headers(other, 'qual-other-refresh'),
      payload: { profileVersionId: qualifiedVersion },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(qualified.snapshot.id);
    console.log(`EVIDENCE isolation ${JSON.stringify({ otherSnapshots: 0, otherRefreshStatus: missing.statusCode })}`);

    const firstBefore = qualified.snapshot.createdAt;
    const [left, right] = await Promise.all([
      refresh(qualifiedVersion, 'qual-refresh-parallel-a'),
      refresh(qualifiedVersion, 'qual-refresh-parallel-b'),
    ]);
    expect(left.statusCode).toBe(201);
    expect(right.statusCode).toBe(201);
    expect(left.snapshot.id).not.toBe(qualified.snapshot.id);
    expect(right.snapshot.id).not.toBe(qualified.snapshot.id);
    expect(left.snapshot.id).not.toBe(right.snapshot.id);
    const stored = await admin.query<{ id: string; created_at: Date; matched_pairs: number }>(
      `SELECT id::text AS id, created_at, matched_pairs FROM evidence_snapshots WHERE id = $1`,
      [qualified.snapshot.id],
    );
    expect(stored.rows[0]?.created_at.toISOString()).toBe(firstBefore);
    expect(stored.rows[0]?.matched_pairs).toBe(20);
    await expect(
      admin.query(`UPDATE evidence_snapshots SET matched_pairs = 0 WHERE id = $1`, [qualified.snapshot.id]),
    ).rejects.toThrow(/immutable/i);
    await expect(
      admin.query(`DELETE FROM evidence_candidate_assessments WHERE snapshot_id = $1`, [qualified.snapshot.id]),
    ).rejects.toThrow(/immutable/i);
    const afterUpdate = await admin.query<{ matched_pairs: number }>(
      `SELECT matched_pairs FROM evidence_snapshots WHERE id = $1`,
      [qualified.snapshot.id],
    );
    expect(afterUpdate.rows[0]?.matched_pairs).toBe(20);
    console.log(
      `EVIDENCE history ${JSON.stringify({ firstId: qualified.snapshot.id, parallelIds: [left.snapshot.id, right.snapshot.id], firstUnchanged: true })}`,
    );
  }, 180_000);

  async function expectCase(
    key: string,
    seed: Parameters<typeof seedRun>[0],
    spec: Parameters<typeof createProfile>[0],
    expected: { status: string; reasonCodes: string[]; uncertainty?: { lower: number; upper: number; differenceLower: number } },
  ): Promise<Snapshot> {
    const deployment = DEPLOYMENT_BY_CASE[key];
    if (deployment === undefined) throw new Error(`missing deployment for ${key}`);
    await seedRun({ ...seed, deployment });
    const versionId = await createProfile({ ...spec, candidateDeployment: deployment });
    const result = await refresh(versionId, `qual-refresh-${key}`);
    expect(result.statusCode, JSON.stringify(result.snapshot)).toBe(201);
    expect(result.snapshot.status).toBe(expected.status);
    expect(result.snapshot.reasonCodes).toEqual(expected.reasonCodes);
    if (expected.uncertainty !== undefined) {
      expect(result.snapshot.uncertainty).toEqual({ method: 'wilson_95_newcombe', ...expected.uncertainty });
    }
    const page = await listed();
    expect(page.some((row) => row.id === result.snapshot.id)).toBe(true);
    expect(JSON.stringify(result.snapshot)).not.toContain(PROMPT);
    return result.snapshot;
  }
});

function setSamplePolicy(db: TestDatabase, tenantId: string, deployment: string): void {
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
      deployment,
    ],
    cliEnv(),
  );
}

async function insertOriginal(client: pg.PoolClient, requestId: string): Promise<void> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO model_attempts (
       tenant_id, request_id, deployment_id, deployment_config_version, upstream_model, status, duration_ms
     )
     SELECT tenant_id, id, deployment_id, deployment_config_version, 'gpt-eval', 'succeeded', 100
     FROM proxy_requests WHERE id = $1
     RETURNING id::text AS id`,
    [requestId],
  );
  const attemptId = inserted.rows[0]?.id;
  if (attemptId === undefined) throw new Error('original attempt was not stored');
  await client.query(
    `INSERT INTO attempt_costs (tenant_id, attempt_id, cost_status, amount)
     SELECT tenant_id, $2, 'reconciled', 0.01 FROM proxy_requests WHERE id = $1`,
    [requestId, attemptId],
  );
}

async function insertAttempt(
  client: pg.PoolClient,
  input: {
    runId: string;
    itemId: string;
    sampleId: string;
    latencyMs: number | null;
    costAmount: string | null;
    costStatus: string;
    adapterVersion: number;
    challengerModel: string;
    deployment: string;
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
     SELECT attempt.tenant_id, $3, $4, $1, req.id, attempt.id, 'completed', 'replay_completed',
            $9, $9, req.deployment_config_version, $5, '{}'::jsonb, $6::integer, $7::numeric, $8::text
     FROM attempt
     JOIN req ON req.tenant_id = attempt.tenant_id`,
    [
      input.sampleId,
      input.challengerModel,
      input.runId,
      input.itemId,
      input.adapterVersion,
      input.latencyMs,
      input.costAmount,
      input.costStatus,
      input.deployment,
    ],
  );
}

async function insertValidator(
  client: pg.PoolClient,
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
  client: pg.PoolClient,
  tenantId: string,
  runId: string,
  itemId: string,
  rubricId: string,
  judge: string,
): Promise<void> {
  const outcome = judge === 'bias' ? 'unstable' : judge === 'inconclusive' ? 'inconclusive' : 'model_b';
  const forward = judge === 'bias' ? 'original' : judge === 'inconclusive' ? null : 'challenger';
  const reverse = judge === 'bias' ? 'challenger' : judge === 'inconclusive' ? null : 'challenger';
  const stop = judge === 'inconclusive' ? 'parse_rejected' : null;
  await client.query(
    `INSERT INTO evaluation_judge_findings (
       tenant_id, run_id, item_id, rubric_version_id, judge_model, rubric_version, outcome,
       forward_mapped, reverse_mapped, stop_reason, latency_ms, cost_amount, cost_status
     )
     VALUES ($1, $2, $3, $4, 'gpt-judge', 1, $5, $6, $7, $8, 5, 0.01, 'reconciled')`,
    [tenantId, runId, itemId, rubricId, outcome, forward, reverse, stop],
  );
}
