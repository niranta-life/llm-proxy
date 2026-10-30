import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { withTenant } from '../src/db/tenant-context.js';
import {
  rankShadow,
  resetShadowRankCache,
  type RankDeployment,
  type RankEvidence,
  type RankFeatures,
  type RankPolicy,
} from '../src/inference/shadow-rank.js';
import { createTestApp, loadTestDatabase, runCli, type TestDatabase } from './helpers.js';
import { adminPool, chatPayload, cliEnv, credentialKey, enableStreaming, provisionTenant, registerInference } from './inference-support.js';
import { completionBody, startMockUpstream, type MockHit } from './mock-openai.js';

const EXPECTED_WINNER = 'rank-tiny';
const EXPECTED_BASELINE = 'rank-base';
const EXPECTED_SAVINGS = '0.21875000';
const HASH = 'ab'.repeat(32);
const NOW = 1_700_000_000_000;
const PROMPT = 'extract the invoice total';

const features: RankFeatures = {
  taskCategory: 'extraction',
  classificationSource: 'rules',
  complexityEstimate: 'low',
  inputSize: 25,
  inputTokenEstimate: 7,
  requestedCapabilities: [],
  contextNeed: 1,
};

function deployment(id: string, patch: Partial<RankDeployment> = {}): RankDeployment {
  return {
    id,
    name: id,
    enabled: true,
    connectionEnabled: true,
    validationStatus: 'validated_live',
    capabilities: ['temperature'],
    contextLimit: 100_000,
    ...patch,
  };
}

function evidence(id: string, patch: Partial<RankEvidence> = {}): RankEvidence {
  return {
    snapshotId: `snap-${id}`,
    deploymentId: id,
    taskCategory: 'extraction',
    complexity: 'low',
    inputSizeCategory: 'xs',
    requiredCapabilities: ['temperature'],
    freshnessSeconds: 2_592_000,
    createdAtMs: NOW,
    status: 'qualified',
    wilsonLower: 0.9,
    matchedPairs: 20,
    expectedCost: 0.25,
    expectedLatencyMs: 400,
    ...patch,
  };
}

function policy(ids: readonly string[], patch: Partial<RankPolicy> = {}): RankPolicy {
  return {
    versionId: 'policy-version-1',
    baselineDeploymentId: EXPECTED_BASELINE,
    candidateDeploymentIds: ids,
    qualityMinPassRate: 0.8,
    qualityMinValidPairs: 1,
    maxCostPerRequest: 1,
    maxLatencyMs: 4000,
    taskSegments: ['extraction'],
    ...patch,
  };
}

const rankedIds = [
  'rank-base',
  'rank-cheap',
  'rank-poor',
  'rank-fast',
  'rank-nocost',
  'rank-blind',
  'rank-tiny',
  'rank-stale',
  'rank-ninth',
];

function rankedDeployments(): RankDeployment[] {
  return [
    deployment('rank-base'),
    deployment('rank-cheap'),
    deployment('rank-poor'),
    deployment('rank-fast', { validationStatus: 'unvalidated' }),
    deployment('rank-nocost'),
    deployment('rank-blind', { capabilities: ['temperature'] }),
    deployment('rank-tiny', { contextLimit: 1 }),
    deployment('rank-stale'),
    deployment('rank-ninth'),
  ];
}

function rankedEvidence(): RankEvidence[] {
  return [
    evidence('rank-base', { expectedCost: 0.25, expectedLatencyMs: 400 }),
    evidence('rank-cheap', { expectedCost: 0.125, expectedLatencyMs: 250 }),
    evidence('rank-poor', { status: 'unqualified', wilsonLower: 0.1, expectedCost: 0.015625, expectedLatencyMs: 5 }),
    evidence('rank-fast', { expectedCost: 0.03125, expectedLatencyMs: 10 }),
    evidence('rank-nocost', { expectedCost: null, expectedLatencyMs: 100 }),
    evidence('rank-blind', { requiredCapabilities: ['seed'], expectedCost: 0.0625, expectedLatencyMs: 80 }),
    evidence('rank-tiny', { expectedCost: 0.03125, expectedLatencyMs: 20 }),
    evidence('rank-stale', { freshnessSeconds: 60, createdAtMs: NOW - 7 * 86_400_000, expectedCost: 0.0625, expectedLatencyMs: 50 }),
    evidence('rank-ninth', { expectedCost: 0.03125, expectedLatencyMs: 30 }),
  ];
}

function decide(patch: {
  features?: RankFeatures;
  policy?: RankPolicy;
  deployments?: readonly RankDeployment[];
  evidence?: readonly RankEvidence[];
  nowMs?: number;
  deadlineMs?: number;
  clock?: () => number;
} = {}) {
  return rankShadow({
    tenantId: '00000000-0000-4000-8000-000000000001',
    nowMs: patch.nowMs ?? NOW,
    deadlineMs: patch.deadlineMs ?? NOW + 60_000,
    ...(patch.clock === undefined ? {} : { clock: patch.clock }),
    features: patch.features ?? features,
    policy: patch.policy ?? policy(rankedIds),
    deployments: patch.deployments ?? rankedDeployments(),
    evidence: patch.evidence ?? rankedEvidence(),
  });
}

function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[index] ?? 0;
}

describe('shadow rank fixtures', () => {
  it('selects the lowest qualified cost', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    expect(outcome.baselineDeploymentId).toBe(EXPECTED_BASELINE);
    expect(outcome.estimatedSavings).toBe(EXPECTED_SAVINGS);
    expect(outcome.savingsKind).toBe('estimate');
    expect(outcome.reasonCodes).toEqual(['lowest_qualified_cost']);
    expect(outcome.eligibleCount).toBe(3);
    expect(outcome.candidateCount).toBe(8);
    expect(outcome.failureReason).toBeNull();
    console.log(
      `EVIDENCE ranking-fixture ${JSON.stringify({
        winner: EXPECTED_WINNER,
        baseline: EXPECTED_BASELINE,
        savings: EXPECTED_SAVINGS,
        savingsKind: outcome.savingsKind,
        eligibleCount: outcome.eligibleCount,
        candidateCount: outcome.candidateCount,
        reasonCodes: outcome.reasonCodes,
      })}`,
    );
  });

  it('excludes a cheap but poor-quality model', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.exclusions.find((item) => item.deployment === 'rank-poor')?.reason).toBe('quality_failed');
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
  });

  it('excludes a fast but unauthorized model', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.exclusions.find((item) => item.deployment === 'rank-fast')?.reason).toBe('unauthorized');
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
  });

  it('excludes a candidate with missing cost', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.exclusions.find((item) => item.deployment === 'rank-nocost')?.reason).toBe('cost_unknown');
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
  });

  it('excludes a candidate whose required capability is absent', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.exclusions.find((item) => item.deployment === 'rank-blind')?.reason).toBe('capability_absent');
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
  });

  it('keeps a small context limit when the output bound is 1', () => {
    resetShadowRankCache();
    const outcome = decide({
      features: { ...features, contextNeed: 1, inputTokenEstimate: 200 },
      policy: policy(['wide', 'costly'], { baselineDeploymentId: 'costly' }),
      deployments: [deployment('wide', { contextLimit: 128 }), deployment('costly')],
      evidence: [
        evidence('wide', { expectedCost: 0.03125, expectedLatencyMs: 20, snapshotId: 'snap-wide' }),
        evidence('costly', { expectedCost: 0.25, expectedLatencyMs: 400, snapshotId: 'snap-costly' }),
      ],
    });
    expect(outcome.exclusions.find((item) => item.deployment === 'wide')).toBeUndefined();
    expect(outcome.recommendedDeploymentId).toBe('wide');
    expect(outcome.estimatedSavings).toBe('0.21875000');
  });

  it('excludes a candidate whose context limit is exceeded', () => {
    resetShadowRankCache();
    const outcome = decide({ features: { ...features, contextNeed: 2 } });
    expect(outcome.exclusions.find((item) => item.deployment === 'rank-tiny')?.reason).toBe('context_exceeded');
    expect(outcome.recommendedDeploymentId).toBe('rank-cheap');
  });

  it('excludes stale evidence', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.exclusions.find((item) => item.deployment === 'rank-stale')?.reason).toBe('evidence_stale');
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
  });

  it('reports an unmatched task', () => {
    resetShadowRankCache();
    const outcome = decide({ features: { ...features, taskCategory: 'coding', classificationSource: 'rules' } });
    expect(outcome.reasonCodes).toEqual(['task_unmatched']);
    expect(outcome.recommendedDeploymentId).toBeNull();
    expect(outcome.failureReason).toBeNull();
  });

  it('reports unknown complexity before candidate checks', () => {
    resetShadowRankCache();
    const outcome = decide({
      features: { ...features, taskCategory: 'unknown', classificationSource: 'unknown' },
      policy: policy(rankedIds, { taskSegments: ['extraction', 'unknown'] }),
    });
    expect(outcome.reasonCodes).toEqual(['unknown_complexity']);
    expect(outcome.recommendedDeploymentId).toBeNull();
  });

  it('falls back to the baseline when no candidate is eligible', () => {
    resetShadowRankCache();
    const outcome = decide({
      deployments: rankedDeployments().map((item) => ({ ...item, validationStatus: 'unvalidated' })),
    });
    expect(outcome.reasonCodes).toEqual(['baseline_fallback']);
    expect(outcome.recommendedDeploymentId).toBeNull();
    expect(outcome.estimatedSavings).toBeNull();
    expect(outcome.failureReason).toBeNull();
    expect(outcome.eligibleCount).toBe(0);
  });

  it('uses lower latency to break an equal cost', () => {
    resetShadowRankCache();
    const outcome = decide({
      policy: policy([EXPECTED_BASELINE, EXPECTED_WINNER]),
      deployments: [deployment(EXPECTED_BASELINE), deployment(EXPECTED_WINNER)],
      evidence: [
        evidence(EXPECTED_BASELINE, { expectedCost: 0.5, expectedLatencyMs: 400, snapshotId: 'snap-tie-base' }),
        evidence(EXPECTED_WINNER, { expectedCost: 0.5, expectedLatencyMs: 100, snapshotId: 'snap-tie-cheap' }),
      ],
    });
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    expect(outcome.reasonCodes).toEqual(['lowest_qualified_cost', 'latency_tie_break']);
    expect(outcome.estimatedSavings).toBe('0.00000000');
  });

  it('ignores a ninth candidate beyond the cap', () => {
    resetShadowRankCache();
    const outcome = decide();
    expect(outcome.candidateCount).toBe(8);
    expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    expect(outcome.exclusions.some((item) => item.deployment === 'rank-ninth')).toBe(false);
  });

  it('times out without caching the failure', () => {
    resetShadowRankCache();
    let ticks = 0;
    const timed = decide({
      clock: () => {
        ticks += 1;
        return ticks === 1 ? NOW : NOW + 5_000;
      },
      deadlineMs: NOW + 5_000,
    });
    expect(timed.failureReason).toBe('ranking_timeout');
    expect(timed.recommendedDeploymentId).toBeNull();
    expect(timed.reasonCodes).toEqual(['ranking_timeout']);
    expect(timed.cacheHit).toBe(false);
    const again = decide();
    expect(again.failureReason).toBeNull();
    expect(again.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    expect(again.cacheHit).toBe(false);
  });

  it('ranks again when the same snapshot passes its freshness window', () => {
    resetShadowRankCache();
    const created = NOW;
    const shared = {
      policy: policy(['only']),
      evidence: [evidence('only', { freshnessSeconds: 60, createdAtMs: created, expectedCost: 0.125, snapshotId: 'snap-clock' })],
    };
    const fresh = decide({
      ...shared,
      nowMs: created + 1_000,
      deadlineMs: created + 200_000,
      deployments: [deployment('only')],
    });
    expect(fresh.recommendedDeploymentId).toBe('only');
    expect(fresh.cacheHit).toBe(false);
    const stale = decide({
      ...shared,
      nowMs: created + 120_000,
      deadlineMs: created + 200_000,
      deployments: [deployment('only')],
    });
    expect(stale.cacheHit).toBe(false);
    expect(stale.recommendedDeploymentId).toBeNull();
    expect(stale.exclusions.find((item) => item.deployment === 'only')?.reason).toBe('evidence_stale');
  });

  it('ranks again when the winning deployment is disabled', () => {
    resetShadowRankCache();
    const shared = {
      policy: policy(['only']),
      evidence: [evidence('only', { expectedCost: 0.125, snapshotId: 'snap-auth' })],
    };
    const enabled = decide({
      ...shared,
      deployments: [deployment('only', { enabled: true })],
    });
    expect(enabled.recommendedDeploymentId).toBe('only');
    const disabled = decide({
      ...shared,
      deployments: [deployment('only', { enabled: false })],
    });
    expect(disabled.cacheHit).toBe(false);
    expect(disabled.recommendedDeploymentId).toBeNull();
    expect(disabled.exclusions.find((item) => item.deployment === 'only')?.reason).toBe('unauthorized');
  });

  it('repeats the same recommendation for an immutable evidence version', () => {
    resetShadowRankCache();
    const first = decide();
    const second = decide();
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(first.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    expect(second.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    expect(second.estimatedSavings).toBe(EXPECTED_SAVINGS);
    expect(second.policyVersionId).toBe(first.policyVersionId);
    expect(second.evidenceSnapshotIds).toEqual(first.evidenceSnapshotIds);
  });
});

type Tenant = { tenantId: string; keyId: string; secret: string; name: string };
type App = Awaited<ReturnType<typeof createTestApp>>;

const CANDIDATES = [
  'rank-base',
  'rank-cheap',
  'rank-poor',
  'rank-fast',
  'rank-nocost',
  'rank-blind',
  'rank-tiny',
  'rank-stale',
] as const;

describe('shadow routing', () => {
  const db = loadTestDatabase();
  const closers: Array<() => Promise<void>> = [];
  let admin: pg.Pool;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let app: App;
  let timeoutApp: App;
  let owner: Tenant;
  let other: Tenant;
  let sampleId = '';
  let policyId = '';
  let policyVersionId = '';
  let shadowOn = false;
  let upstreamMode: 'ok' | 'rate-limit-once' | 'unavailable' = 'ok';
  let limited = false;
  let storedRecommendation: Record<string, unknown> | null = null;
  let shadowOverheadMs = 0;
  let shadowProviderCalls = 0;

  function auth(tenant: Tenant, idempotencyKey?: string): Record<string, string> {
    return {
      'x-tenant-id': tenant.tenantId,
      authorization: `Bearer ${tenant.secret}`,
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    };
  }

  function frames(model: string): string {
    const frame = (choice: Record<string, unknown>) =>
      `data: ${JSON.stringify({
        id: 'chatcmpl-rank',
        object: 'chat.completion.chunk',
        created: 1_700_000_000,
        model,
        choices: [choice],
      })}\n\n`;
    return [
      frame({ index: 0, delta: { role: 'assistant' }, finish_reason: null }),
      frame({ index: 0, delta: { content: 'ok' }, finish_reason: null }),
      frame({ index: 0, delta: {}, finish_reason: 'stop' }),
      'data: [DONE]\n\n',
    ].join('');
  }

  function addDeployment(tenantId: string, name: string, model: string, capabilities = 'temperature'): void {
    runCli(
      db,
      [
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
        'true',
      ],
      cliEnv(),
    );
  }

  async function markLive(tenantId: string, name: string): Promise<void> {
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = $2`,
      [tenantId, name],
    );
  }

  function contextLimit(tenantId: string, name: string, limit: number): void {
    runCli(
      db,
      ['set-deployment-context-limit', '--tenant-id', tenantId, '--deployment', name, '--context-limit', String(limit)],
      cliEnv(),
    );
  }

  function dataCollection(tenantId: string, name: string): void {
    runCli(
      db,
      ['set-deployment-data-collection', '--tenant-id', tenantId, '--deployment', name, '--data-collection', 'allow'],
      cliEnv(),
    );
  }

  async function captureSample(): Promise<string> {
    const response = await app.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(owner),
      payload: chatPayload('auto', PROMPT),
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

  async function approveProfile(): Promise<string> {
    const created = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: auth(owner),
      payload: {
        name: 'rank-extract',
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
      headers: auth(owner),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return body.versionId;
  }

  async function seedEvidence(
    outputRequirementId: string,
    input: {
      name: string;
      cost: string | null;
      latency: number | null;
      qualified: boolean;
      freshnessSeconds: number;
      stale: boolean;
      requiredCapabilities: string[];
    },
  ): Promise<void> {
    const created = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/qualification-profiles',
      headers: auth(owner, `qp-${input.name}`),
      payload: {
        name: `qp-${input.name}`,
        taskCategory: 'extraction',
        complexity: 'low',
        inputSizeCategory: 'xs',
        outputRequirementId,
        requiredCapabilities: input.requiredCapabilities,
        candidateDeployment: input.name,
        modelVersion: 'gpt-rank-1',
        deploymentConfigVersion: 1,
        adapterVersion: 1,
        minSamples: 1,
        objectiveFloor: '0.80000',
        maxIntervalWidth: '0.20000',
        noninferiorityMargin: '0.05000',
        freshnessSeconds: input.freshnessSeconds,
        minCoverage: '1.00000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const versionId = (created.json() as { versionId: string }).versionId;
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const definition = await client.query<{ id: string }>(
        `INSERT INTO evaluation_definitions (tenant_id, name) VALUES ($1, $2) RETURNING id::text AS id`,
        [owner.tenantId, `def-${input.name}`],
      );
      const definitionId = definition.rows[0]?.id;
      if (definitionId === undefined) throw new Error('definition was not stored');
      const version = await client.query<{ id: string }>(
        `INSERT INTO evaluation_definition_versions (tenant_id, definition_id, version, config)
         VALUES ($1, $2, 1, '{"mode":"dry_run","modelExecution":"off"}'::jsonb)
         RETURNING id::text AS id`,
        [owner.tenantId, definitionId],
      );
      const definitionVersionId = version.rows[0]?.id;
      if (definitionVersionId === undefined) throw new Error('definition version was not stored');
      const run = await client.query<{ id: string }>(
        `INSERT INTO evaluation_runs (
           tenant_id, definition_version_id, status, idempotency_key, request_hash, config_snapshot,
           sample_category, challenger_deployment, budget_estimate, item_count,
           pending_count, queued_count, running_count, completed_count, failed_count, cancelled_count
         ) VALUES (
           $1, $2, 'completed', $3, $4, '{"mode":"dry_run","modelExecution":"off"}'::jsonb,
           'extraction', $5, 0.25, 1,
           0, 0, 0, 1, 0, 0
         ) RETURNING id::text AS id`,
        [owner.tenantId, definitionVersionId, `run-${input.name}`, HASH, input.name],
      );
      const runId = run.rows[0]?.id;
      if (runId === undefined) throw new Error('run was not stored');
      const item = await client.query<{ id: string }>(
        `INSERT INTO evaluation_items (tenant_id, run_id, sample_id, ordinal, status, reason_code)
         VALUES ($1, $2, $3, 0, 'completed', 'dry_run')
         RETURNING id::text AS id`,
        [owner.tenantId, runId, sampleId],
      );
      const itemId = item.rows[0]?.id;
      if (itemId === undefined) throw new Error('item was not stored');
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
                $8, $8, req.deployment_config_version, 1, '{}'::jsonb, $5::integer, $6::numeric, $7::text
         FROM attempt
         JOIN req ON req.tenant_id = attempt.tenant_id`,
        [sampleId, 'gpt-rank-1', runId, itemId, input.latency, input.cost, input.cost === null ? null : 'reconciled', input.name],
      );
      const snapshot = await client.query<{ id: string }>(
        `INSERT INTO evidence_snapshots (
           tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
           idempotency_key, request_hash, created_at
         ) VALUES (
           $1, $2, ARRAY[$3]::uuid[], 1, 20, $4, $5,
           CASE WHEN $6::boolean THEN now() - interval '7 days' ELSE now() END
         ) RETURNING id::text AS id`,
        [owner.tenantId, versionId, runId, `snap-${input.name}`, HASH, input.stale],
      );
      const snapshotId = snapshot.rows[0]?.id;
      if (snapshotId === undefined) throw new Error('snapshot was not stored');
      if (input.qualified) {
        await client.query(
          `INSERT INTO evidence_candidate_assessments (
             tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
             challenger_passes, challenger_trials, original_passes, original_trials
           ) VALUES ($1, $2, 'qualified', '{}', 0.9, 1, 0, 20, 20, 20, 20)`,
          [owner.tenantId, snapshotId],
        );
      } else {
        await client.query(
          `INSERT INTO evidence_candidate_assessments (
             tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
             challenger_passes, challenger_trials, original_passes, original_trials
           ) VALUES ($1, $2, 'unqualified', ARRAY['objective_threshold_failed'], 0.1, 0.2, -0.5, 1, 20, 20, 20)`,
          [owner.tenantId, snapshotId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function enableShadow(): Promise<void> {
    if (shadowOn) return;
    const validated = await app.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policyId}/validate`,
      headers: auth(owner, 'rank-validate'),
      payload: { expectedEpoch: 1 },
    });
    expect(validated.statusCode, validated.body).toBe(200);
    const shadowed = await app.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policyId}/status`,
      headers: auth(owner, 'rank-shadow'),
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(shadowed.statusCode, shadowed.body).toBe(200);
    expect(shadowed.json().status).toBe('shadow');
    policyVersionId = shadowed.json().versionId as string;
    shadowOn = true;
  }

  async function chat(target: App, tenant: Tenant, model: string, content: string, extra: Record<string, unknown> = {}) {
    return target.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(tenant),
      payload: chatPayload(model, content, extra),
    });
  }

  async function simulate(target: App, tenant: Tenant, body: Record<string, unknown>) {
    return target.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/simulate',
      headers: auth(tenant),
      payload: body,
    });
  }

  function simulateBody(content: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { model: 'auto', messages: [{ role: 'user', content }], ...extra };
  }

  function calledModel(hit: MockHit): string {
    return (JSON.parse(hit.body) as { model?: string }).model ?? '';
  }

  beforeAll(async () => {
    mock = await startMockUpstream((hit, _request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; stream?: boolean };
      const model = parsed.model ?? '';
      if (parsed.stream === true) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(frames(model));
        return;
      }
      if (upstreamMode === 'unavailable' && model === 'gpt-rank-base') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      if (upstreamMode === 'rate-limit-once' && model === 'gpt-rank-base' && !limited) {
        limited = true;
        response.writeHead(429, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'slow down', type: 'rate_limit', code: 'rate_limit' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(model, 'ok')));
    });
    owner = provisionTenant(db, 'Shadow Rank A');
    other = provisionTenant(db, 'Shadow Rank B');
    registerInference(db, {
      tenantId: owner.tenantId,
      apiKey: 'sk-shadow-rank-a',
      deployment: 'rank-base',
      upstreamModel: 'gpt-rank-base',
      capabilities: 'temperature',
    });
    for (const name of ['rank-cheap', 'rank-poor', 'rank-fast', 'rank-nocost', 'rank-blind', 'rank-tiny', 'rank-stale', 'rank-spare', 'rank-ninth']) {
      addDeployment(owner.tenantId, name, `gpt-${name}`, name === 'rank-tiny' ? 'temperature,max_tokens' : 'temperature');
    }
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-shadow-rank-b',
      deployment: 'b-chat',
      upstreamModel: 'gpt-b-base',
      capabilities: 'temperature',
    });
    admin = adminPool(db);
    for (const name of ['rank-base', 'rank-cheap', 'rank-poor', 'rank-nocost', 'rank-blind', 'rank-stale', 'rank-spare', 'rank-ninth']) {
      await markLive(owner.tenantId, name);
      contextLimit(owner.tenantId, name, 100_000);
    }
    await markLive(owner.tenantId, 'rank-tiny');
    contextLimit(owner.tenantId, 'rank-tiny', 1);
    contextLimit(owner.tenantId, 'rank-fast', 100_000);
    await markLive(other.tenantId, 'b-chat');
    contextLimit(other.tenantId, 'b-chat', 100_000);
    dataCollection(owner.tenantId, 'rank-base');
    dataCollection(owner.tenantId, 'rank-spare');
    runCli(
      db,
      ['set-deployment-data-class', '--tenant-id', owner.tenantId, '--deployment', 'rank-base', '--data-class', 'internal'],
      cliEnv(),
    );
    runCli(
      db,
      [
        'set-sample-policy',
        '--tenant-id',
        owner.tenantId,
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
        'rank-base',
      ],
      cliEnv(),
    );
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [owner.tenantId, owner.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [owner.tenantId, owner.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [other.tenantId, other.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [other.tenantId, other.keyId]);
    app = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey, rankDeadlineMs: 30_000 });
    timeoutApp = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey, rankDeadlineMs: 0 });
    closers.push(async () => {
      await app.app.close();
      await timeoutApp.app.close();
      await app.authPool.end();
      await app.runtimePool.end();
      await timeoutApp.authPool.end();
      await timeoutApp.runtimePool.end();
      await admin.end();
      await mock.close();
    });
    const outputRequirementId = await approveProfile();
    const drafted = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(owner, 'rank-policy'),
      payload: {
        name: 'auto-rank',
        alias: 'auto',
        baselineDeployment: 'rank-base',
        candidateDeployments: [...CANDIDATES],
        qualityMinPassRate: '0.80000',
        qualityMinValidPairs: 1,
        maxCostPerRequest: '1.00000000',
        maxLatencyMs: 4000,
        taskSegments: ['extraction'],
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    policyId = drafted.json().id as string;
    const otherDraft = await app.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(other, 'rank-policy-b'),
      payload: {
        name: 'auto-rank',
        alias: 'auto',
        baselineDeployment: 'b-chat',
        candidateDeployments: ['b-chat'],
        qualityMinPassRate: '0.80000',
        qualityMinValidPairs: 1,
        maxCostPerRequest: '1.00000000',
        maxLatencyMs: 4000,
        taskSegments: ['extraction'],
      },
    });
    expect(otherDraft.statusCode, otherDraft.body).toBe(201);
    const otherId = otherDraft.json().id as string;
    const otherValidated = await app.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${otherId}/validate`,
      headers: auth(other, 'rank-validate-b'),
      payload: { expectedEpoch: 1 },
    });
    expect(otherValidated.statusCode, otherValidated.body).toBe(200);
    const otherShadow = await app.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${otherId}/status`,
      headers: auth(other, 'rank-shadow-b'),
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(otherShadow.statusCode, otherShadow.body).toBe(200);
    sampleId = await captureSample();
    const seeds = [
      { name: 'rank-base', cost: '0.25000000', latency: 400, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
      { name: 'rank-cheap', cost: '0.12500000', latency: 250, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
      { name: 'rank-poor', cost: '0.01562500', latency: 5, qualified: false, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
      { name: 'rank-fast', cost: '0.03125000', latency: 10, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
      { name: 'rank-nocost', cost: null, latency: 100, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
      { name: 'rank-blind', cost: '0.06250000', latency: 80, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['seed'] },
      { name: 'rank-tiny', cost: '0.03125000', latency: 20, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
      { name: 'rank-stale', cost: '0.06250000', latency: 50, qualified: true, freshnessSeconds: 60, stale: true, requiredCapabilities: ['temperature'] },
      { name: 'rank-ninth', cost: '0.03125000', latency: 30, qualified: true, freshnessSeconds: 2_592_000, stale: false, requiredCapabilities: ['temperature'] },
    ];
    for (const seed of seeds) await seedEvidence(outputRequirementId, seed);
  }, 180_000);

  afterAll(async () => {
    while (closers.length > 0) {
      const close = closers.pop();
      if (close) await close();
    }
  });

  it('leaves model=auto on the alias baseline while shadow ranking is disabled', async () => {
    const before = mock.hits.length;
    const response = await chat(app, owner, 'auto', PROMPT);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe(EXPECTED_BASELINE);
    expect(mock.hits.length - before).toBe(1);
    expect(calledModel(mock.hits.at(-1) as MockHit)).toBe('gpt-rank-base');
    const requestId = String(response.headers['x-request-id']);
    const ranking = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(ranking.statusCode).toBe(404);
    const beforeSimulate = mock.hits.length;
    const simulated = await simulate(app, owner, simulateBody(PROMPT));
    expect(simulated.statusCode, simulated.body).toBe(200);
    expect(simulated.json()).toMatchObject({
      routingMode: 'static',
      reasonCodes: ['no_shadow_policy'],
      recommendedDeployment: null,
      savingsKind: 'estimate',
    });
    expect(mock.hits.length - beforeSimulate).toBe(0);
    const migration = await admin.query(`SELECT 1 FROM schema_migrations WHERE version = '028_shadow_ranking.sql'`);
    expect(migration.rowCount).toBe(1);
    console.log(
      `EVIDENCE routing-unchanged ${JSON.stringify({
        phase: 'disabled',
        deployment: response.headers['x-deployment'],
        upstreamModel: 'gpt-rank-base',
        providerCalls: 1,
        rankingStored: false,
        simulateRoutingMode: 'static',
      })}`,
    );
    console.log(
      `EVIDENCE rollback ${JSON.stringify({
        migrationApplied: '028_shadow_ranking.sql',
        shadowEnabled: false,
        deployment: response.headers['x-deployment'],
        upstreamModel: 'gpt-rank-base',
        providerCalls: mock.hits.length - before,
      })}`,
    );
  });

  it('selects the lowest qualified cost and still executes the baseline', async () => {
    await enableShadow();
    resetShadowRankCache();
    const beforeSimulate = mock.hits.length;
    const first = await simulate(app, owner, simulateBody(PROMPT));
    expect(first.statusCode, first.body).toBe(200);
    expect(mock.hits.length - beforeSimulate).toBe(0);
    const recommendation = first.json();
    expect(recommendation.recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(recommendation.baselineDeployment).toBe(EXPECTED_BASELINE);
    expect(recommendation.actualDeployment).toBeNull();
    expect(recommendation.estimatedSavings).toBe(EXPECTED_SAVINGS);
    expect(recommendation.savingsKind).toBe('estimate');
    expect(recommendation.reasonCodes).toEqual(['lowest_qualified_cost']);
    expect(recommendation.candidateCount).toBe(8);
    expect(recommendation.eligibleCount).toBe(3);
    expect(recommendation.policyVersionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recommendation.evidenceSnapshotIds.length).toBeGreaterThan(0);
    expect(recommendation.cacheHit).toBe(false);
    const reasons = Object.fromEntries(
      (recommendation.exclusions as Array<{ deployment: string; reason: string }>).map((item) => [item.deployment, item.reason]),
    );
    expect(reasons).toEqual({
      'rank-poor': 'quality_failed',
      'rank-fast': 'unauthorized',
      'rank-nocost': 'cost_unknown',
      'rank-blind': 'capability_absent',
      'rank-stale': 'evidence_stale',
    });
    expect(reasons['rank-ninth']).toBeUndefined();
    const second = await simulate(app, owner, simulateBody(PROMPT));
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().cacheHit).toBe(true);
    expect(second.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(mock.hits.length - beforeSimulate).toBe(0);
    const beforeChat = mock.hits.length;
    const response = await chat(app, owner, 'auto', PROMPT);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe(EXPECTED_BASELINE);
    expect(response.json().model).toBe('gpt-rank-base');
    expect(mock.hits.length - beforeChat).toBe(1);
    expect(calledModel(mock.hits.at(-1) as MockHit)).toBe('gpt-rank-base');
    expect((JSON.parse((mock.hits.at(-1) as MockHit).body) as { messages: Array<{ content: string }> }).messages[0]?.content).toBe(PROMPT);
    const requestId = String(response.headers['x-request-id']);
    const stored = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(stored.statusCode, stored.body).toBe(200);
    const row = stored.json();
    expect(row.recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(row.baselineDeployment).toBe(EXPECTED_BASELINE);
    expect(row.actualDeployment).toBe(EXPECTED_BASELINE);
    expect(row.estimatedSavings).toBe(EXPECTED_SAVINGS);
    expect(row.savingsKind).toBe('estimate');
    expect(row.policyVersionId).toBe(policyVersionId);
    expect(row.evidenceSnapshotIds.length).toBeGreaterThan(0);
    expect(row.recommendedDeployment).not.toBe(row.actualDeployment);
    shadowOverheadMs = row.computationMs as number;
    shadowProviderCalls = 1;
    storedRecommendation = row;
    const metrics = await app.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/shadow-metrics',
      headers: auth(owner),
    });
    expect(metrics.statusCode, metrics.body).toBe(200);
    expect(metrics.json()).toMatchObject({
      savingsKind: 'estimate',
      predictedSavingsNote: 'estimate',
      predictedSavings: '0.65625000',
      candidateCount: 24,
      decisionFailures: 0,
      decisions: 3,
    });
    expect(metrics.json().cacheHits).toBeGreaterThanOrEqual(1);
    console.log(`EVIDENCE simulation ${JSON.stringify(recommendation)}`);
    console.log(
      `EVIDENCE comparison ${JSON.stringify({
        recommendedDeployment: row.recommendedDeployment,
        baselineDeployment: row.baselineDeployment,
        actualDeployment: row.actualDeployment,
        upstreamModel: 'gpt-rank-base',
        providerCalls: 1,
        savingsKind: row.savingsKind,
        estimatedSavings: row.estimatedSavings,
        policyVersionId: row.policyVersionId,
        evidenceSnapshotIds: row.evidenceSnapshotIds,
      })}`,
    );
    console.log(
      `EVIDENCE routing-unchanged ${JSON.stringify({
        phase: 'enabled',
        deployment: response.headers['x-deployment'],
        upstreamModel: 'gpt-rank-base',
        providerCalls: 1,
        recommendedDeployment: row.recommendedDeployment,
        baselineDeployment: row.baselineDeployment,
        actualDeployment: row.actualDeployment,
        savingsKind: row.savingsKind,
      })}`,
    );
    console.log(`EVIDENCE shadow-metrics ${JSON.stringify(metrics.json())}`);
  });

  it('excludes a cheap but poor-quality model on the simulate route', () => {
    const reasons = Object.fromEntries(
      ((storedRecommendation?.exclusions ?? []) as Array<{ deployment: string; reason: string }>).map((item) => [item.deployment, item.reason]),
    );
    expect(reasons['rank-poor']).toBe('quality_failed');
    expect(storedRecommendation?.recommendedDeployment).toBe(EXPECTED_WINNER);
  });

  it('excludes a fast but unauthorized model on the simulate route', () => {
    const exclusions = (storedRecommendation?.exclusions ?? []) as Array<{ deployment: string; reason: string }>;
    expect(exclusions.find((item) => item.deployment === 'rank-fast')?.reason).toBe('unauthorized');
  });

  it('excludes missing cost on the simulate route', () => {
    const exclusions = (storedRecommendation?.exclusions ?? []) as Array<{ deployment: string; reason: string }>;
    expect(exclusions.find((item) => item.deployment === 'rank-nocost')?.reason).toBe('cost_unknown');
  });

  it('excludes a missing required capability on the simulate route', () => {
    const exclusions = (storedRecommendation?.exclusions ?? []) as Array<{ deployment: string; reason: string }>;
    expect(exclusions.find((item) => item.deployment === 'rank-blind')?.reason).toBe('capability_absent');
  });

  it('excludes a context limit that is exceeded on the simulate route', async () => {
    const before = mock.hits.length;
    const response = await simulate(app, owner, simulateBody(PROMPT, { max_tokens: 2 }));
    expect(response.statusCode, response.body).toBe(200);
    const exclusions = response.json().exclusions as Array<{ deployment: string; reason: string }>;
    expect(exclusions.find((item) => item.deployment === 'rank-tiny')?.reason).toBe('context_exceeded');
    expect(response.json().recommendedDeployment).not.toBe('rank-tiny');
    expect(response.json().savingsKind).toBe('estimate');
    expect(mock.hits.length - before).toBe(0);
  });

  it('excludes stale evidence on the simulate route', () => {
    const exclusions = (storedRecommendation?.exclusions ?? []) as Array<{ deployment: string; reason: string }>;
    expect(exclusions.find((item) => item.deployment === 'rank-stale')?.reason).toBe('evidence_stale');
  });

  it('reports an unmatched task and does not call a provider', async () => {
    const before = mock.hits.length;
    const response = await simulate(app, owner, simulateBody('zzzz'));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().reasonCodes).toEqual(['task_unmatched']);
    expect(response.json().recommendedDeployment).toBeNull();
    expect(response.json().baselineDeployment).toBe(EXPECTED_BASELINE);
    expect(response.json().savingsKind).toBe('estimate');
    expect(mock.hits.length - before).toBe(0);
  });

  it('reports unknown complexity and falls back to the baseline', async () => {
    const content = `extract ${'x'.repeat(7992)}`;
    expect(content.length).toBe(8000);
    const before = mock.hits.length;
    const response = await simulate(app, owner, simulateBody(content));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().reasonCodes).toEqual(['baseline_fallback']);
    expect(response.json().recommendedDeployment).toBeNull();
    const reasons = Object.fromEntries(
      (response.json().exclusions as Array<{ deployment: string; reason: string }>).map((item) => [item.deployment, item.reason]),
    );
    expect(reasons['rank-cheap']).toBe('unknown_complexity');
    expect(reasons['rank-base']).toBe('unknown_complexity');
    expect(reasons['rank-fast']).toBe('unauthorized');
    expect(reasons['rank-tiny']).toBe('unknown_complexity');
    expect(mock.hits.length - before).toBe(0);
  });

  it('bypasses a forced model and executes that deployment', async () => {
    const beforeNamed = mock.hits.length;
    const named = await simulate(app, owner, { model: 'rank-poor', messages: [{ role: 'user', content: PROMPT }] });
    expect(named.statusCode, named.body).toBe(200);
    expect(named.json()).toMatchObject({
      routingMode: 'bypass',
      reasonCodes: ['named_model'],
      recommendedDeployment: null,
      baselineDeployment: null,
      actualDeployment: null,
      savingsKind: 'estimate',
    });
    expect(mock.hits.length - beforeNamed).toBe(0);
    const rowsBefore = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routing_shadow_rankings WHERE tenant_id = $1 AND routing_mode = 'bypass'`,
      [owner.tenantId],
    );
    const before = mock.hits.length;
    const response = await chat(app, owner, 'rank-poor', PROMPT);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe('rank-poor');
    expect(response.json().model).toBe('gpt-rank-poor');
    expect(mock.hits.length - before).toBe(1);
    expect(calledModel(mock.hits.at(-1) as MockHit)).toBe('gpt-rank-poor');
    const requestId = String(response.headers['x-request-id']);
    const stored = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json()).toMatchObject({
      routingMode: 'bypass',
      reasonCodes: ['named_model'],
      recommendedDeployment: null,
      baselineDeployment: null,
      actualDeployment: 'rank-poor',
      savingsKind: 'estimate',
      estimatedSavings: null,
    });
    const rowsAfter = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM routing_shadow_rankings WHERE tenant_id = $1 AND routing_mode = 'bypass'`,
      [owner.tenantId],
    );
    expect(rowsAfter.rows[0]?.n).toBe((rowsBefore.rows[0]?.n ?? 0) + 1);
  });

  it('records a ranking timeout and still executes the baseline', async () => {
    const beforeSimulate = mock.hits.length;
    const simulated = await simulate(timeoutApp, owner, simulateBody(PROMPT));
    expect(simulated.statusCode, simulated.body).toBe(200);
    expect(simulated.json()).toMatchObject({
      routingMode: 'failed',
      failureReason: 'ranking_timeout',
      reasonCodes: ['ranking_timeout'],
      recommendedDeployment: null,
      baselineDeployment: EXPECTED_BASELINE,
      actualDeployment: null,
      estimatedSavings: null,
      savingsKind: 'estimate',
    });
    expect(JSON.stringify(simulated.json())).not.toContain('select ');
    expect(mock.hits.length - beforeSimulate).toBe(0);
    const before = mock.hits.length;
    const response = await chat(timeoutApp, owner, 'auto', PROMPT);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe(EXPECTED_BASELINE);
    expect(response.json().model).toBe('gpt-rank-base');
    expect(mock.hits.length - before).toBe(1);
    const requestId = String(response.headers['x-request-id']);
    const stored = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json()).toMatchObject({
      routingMode: 'failed',
      failureReason: 'ranking_timeout',
      recommendedDeployment: null,
      baselineDeployment: EXPECTED_BASELINE,
      actualDeployment: EXPECTED_BASELINE,
      savingsKind: 'estimate',
    });
  });

  it('keeps a qualified snapshot that is older than newer snapshots for other segments', async () => {
    await admin.query(
      `WITH target AS (
         SELECT v.tenant_id, v.candidate_deployment_id, v.output_requirement_id
         FROM qualification_profile_versions v
         JOIN model_deployments d ON d.tenant_id = v.tenant_id AND d.id = v.candidate_deployment_id
         WHERE d.tenant_id = $1 AND d.name = 'rank-cheap'
         LIMIT 1
       ),
       series AS (
         SELECT generate_series(1, 33) AS n
       ),
       profiles AS (
         INSERT INTO qualification_profiles (tenant_id, name)
         SELECT target.tenant_id, 'noise-' || series.n
         FROM target
         CROSS JOIN series
         RETURNING id, tenant_id, name
       ),
       versions AS (
         INSERT INTO qualification_profile_versions (
           tenant_id, profile_id, version, task_category, complexity, input_size_category,
           output_requirement_id, required_capabilities, candidate_deployment_id,
           model_version, deployment_config_version, adapter_version,
           min_samples, objective_floor, max_interval_width, noninferiority_margin,
           freshness_seconds, min_coverage, config_digest, idempotency_key, request_hash
         )
         SELECT profiles.tenant_id, profiles.id, 1, 'coding', 'high', 'xxl',
                target.output_requirement_id, ARRAY['temperature']::text[], target.candidate_deployment_id,
                'gpt-rank-1', 1, 1,
                1, 0.80000, 0.20000, 0.05000,
                2592000, 1.00000, $2, 'noise-key-' || profiles.name, $2
         FROM profiles
         JOIN target ON target.tenant_id = profiles.tenant_id
         RETURNING id, tenant_id
       ),
       snapshots AS (
         INSERT INTO evidence_snapshots (
           tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
           idempotency_key, request_hash
         )
         SELECT tenant_id, id, '{}'::uuid[], 1, 20, 'noise-snap-' || id::text, $2
         FROM versions
         RETURNING id, tenant_id
       )
       INSERT INTO evidence_candidate_assessments (
         tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
         challenger_passes, challenger_trials, original_passes, original_trials
       )
       SELECT tenant_id, id, 'qualified', '{}', 0.9, 1, 0, 20, 20, 20, 20
       FROM snapshots`,
      [owner.tenantId, HASH],
    );
    const before = mock.hits.length;
    const response = await simulate(app, owner, simulateBody(PROMPT));
    expect(response.statusCode, response.body).toBe(200);
    const reasons = Object.fromEntries(
      (response.json().exclusions as Array<{ deployment: string; reason: string }>).map((item) => [item.deployment, item.reason]),
    );
    expect(reasons['rank-cheap']).toBeUndefined();
    expect(response.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(response.json().eligibleCount).toBe(3);
    expect(mock.hits.length - before).toBe(0);
  });

  it('keeps a large candidate set inside the cap and ignores a cheaper outsider', async () => {
    expect(CANDIDATES).toHaveLength(8);
    const response = await simulate(app, owner, simulateBody(PROMPT));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().candidateCount).toBe(8);
    expect(response.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    const names = (response.json().exclusions as Array<{ deployment: string }>).map((item) => item.deployment);
    expect(names).not.toContain('rank-ninth');
    expect(names).not.toContain('rank-spare');
  });

  it('ranks two tenants in parallel without mixing recommendations', async () => {
    const before = mock.hits.length;
    const [left, right] = await Promise.all([
      simulate(app, owner, simulateBody(PROMPT)),
      simulate(app, other, simulateBody(PROMPT)),
    ]);
    expect(left.statusCode, left.body).toBe(200);
    expect(right.statusCode, right.body).toBe(200);
    expect(left.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(left.json().baselineDeployment).toBe(EXPECTED_BASELINE);
    expect(right.json().recommendedDeployment).toBeNull();
    expect(right.json().baselineDeployment).toBe('b-chat');
    expect(right.json().reasonCodes).toEqual(['baseline_fallback']);
    expect(right.json().savingsKind).toBe('estimate');
    expect(mock.hits.length - before).toBe(0);
  });

  it('hides tenant A rankings from tenant B', async () => {
    const requestId = String(storedRecommendation?.requestId ?? '');
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/);
    const hidden = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(other),
    });
    expect(hidden.statusCode).toBe(404);
    const mismatched = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-metrics?tenantId=${owner.tenantId}`,
      headers: auth(other),
    });
    expect(mismatched.statusCode).toBe(200);
    expect(mismatched.json()).toMatchObject({
      savingsKind: 'estimate',
      predictedSavings: '0.00000000',
      predictedSavingsNote: 'estimate',
      decisions: 0,
      decisionFailures: 0,
    });
    const seen = await withTenant(app.runtimePool, other.tenantId, async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM routing_shadow_rankings WHERE request_id = $1`,
        [requestId],
      );
      return result.rows[0]?.n ?? 0;
    });
    expect(seen).toBe(0);
    const own = await withTenant(app.runtimePool, owner.tenantId, async (client) => {
      const result = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM routing_shadow_rankings WHERE request_id = $1`,
        [requestId],
      );
      return result.rows[0]?.n ?? 0;
    });
    expect(own).toBe(1);
    const otherMetrics = await app.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/shadow-metrics',
      headers: auth(other),
    });
    expect(otherMetrics.statusCode).toBe(200);
    expect(otherMetrics.json().savingsKind).toBe('estimate');
    expect(otherMetrics.json().predictedSavings).toBe('0.00000000');
    expect(otherMetrics.json().predictedSavingsNote).toBe('estimate');
    console.log(
      `EVIDENCE isolation ${JSON.stringify({
        otherHttpStatus: hidden.statusCode,
        otherVisibleRows: seen,
        ownerVisibleRows: own,
        otherPredictedSavings: otherMetrics.json().predictedSavings,
        otherSavingsKind: otherMetrics.json().savingsKind,
      })}`,
    );
  });

  it('keeps a streaming request on the baseline deployment', async () => {
    enableStreaming(db, { tenantId: owner.tenantId, deployment: 'rank-base' });
    const before = mock.hits.length;
    const response = await chat(app, owner, 'auto', PROMPT, { stream: true });
    expect(response.statusCode, response.body).toBe(200);
    expect(String(response.headers['content-type'])).toContain('text/event-stream');
    expect(response.body).toContain('data: [DONE]');
    expect(response.headers['x-deployment']).toBe(EXPECTED_BASELINE);
    expect(mock.hits.length - before).toBe(1);
    expect(calledModel(mock.hits.at(-1) as MockHit)).toBe('gpt-rank-base');
    const requestId = String(response.headers['x-request-id']);
    const stored = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(stored.json().actualDeployment).toBe(EXPECTED_BASELINE);
    expect(stored.json().savingsKind).toBe('estimate');
  });

  it('retries the baseline and does not call the recommended model', async () => {
    upstreamMode = 'rate-limit-once';
    limited = false;
    runCli(
      db,
      [
        'set-execution-policy',
        '--tenant-id',
        owner.tenantId,
        '--deployment',
        'rank-base',
        '--retries',
        'true',
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
      ],
      cliEnv(),
    );
    const before = mock.hits.length;
    const response = await chat(app, owner, 'auto', PROMPT);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe(EXPECTED_BASELINE);
    expect(response.headers['x-attempt-count']).toBe('2');
    expect(response.headers['x-fallback']).toBe('false');
    const added = mock.hits.slice(before);
    expect(added).toHaveLength(2);
    expect(added.map((hit) => calledModel(hit))).toEqual(['gpt-rank-base', 'gpt-rank-base']);
    const requestId = String(response.headers['x-request-id']);
    const stored = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(stored.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(stored.json().actualDeployment).toBe(EXPECTED_BASELINE);
    upstreamMode = 'ok';
    runCli(
      db,
      [
        'set-execution-policy',
        '--tenant-id',
        owner.tenantId,
        '--deployment',
        'rank-base',
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
      ],
      cliEnv(),
    );
  });

  it('falls back to the stored secondary and does not execute the recommendation', async () => {
    runCli(
      db,
      [
        'set-fallback-policy',
        '--tenant-id',
        owner.tenantId,
        '--alias',
        'auto',
        '--enabled',
        'true',
        '--deployments',
        'rank-spare',
        '--failures',
        'unavailable',
        '--max-attempts',
        '2',
        '--capabilities',
        'temperature',
        '--providers',
        'openai',
        '--data-collection',
        'allow',
        '--min-remaining-deadline-ms',
        '0',
      ],
      cliEnv(),
    );
    upstreamMode = 'unavailable';
    const before = mock.hits.length;
    const response = await chat(app, owner, 'auto', PROMPT);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-fallback']).toBe('true');
    expect(response.headers['x-attempt-count']).toBe('2');
    expect(response.headers['x-deployment']).toBe('rank-spare');
    const added = mock.hits.slice(before);
    expect(added.map((hit) => calledModel(hit))).toEqual(['gpt-rank-base', 'gpt-rank-spare']);
    const requestId = String(response.headers['x-request-id']);
    const stored = await app.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/shadow-rankings/${requestId}`,
      headers: auth(owner),
    });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json().recommendedDeployment).toBe(EXPECTED_WINNER);
    expect(stored.json().actualDeployment).toBe(EXPECTED_BASELINE);
    expect(stored.json().actualDeployment).not.toBe('rank-spare');
    expect(stored.json().savingsKind).toBe('estimate');
    upstreamMode = 'ok';
  });

  it('measures ranking computation on the bounded candidate set', () => {
    resetShadowRankCache();
    const before = mock.hits.length;
    const samples: number[] = [];
    let cacheHits = 0;
    let decisionFailures = 0;
    let candidateCount = 0;
    for (let index = 0; index < 40; index += 1) {
      const started = performance.now();
      const outcome = decide();
      samples.push(Math.round((performance.now() - started) * 1000) / 1000);
      if (outcome.cacheHit) cacheHits += 1;
      if (outcome.failureReason !== null) decisionFailures += 1;
      candidateCount = outcome.candidateCount;
      expect(outcome.recommendedDeploymentId).toBe(EXPECTED_WINNER);
    }
    const sorted = [...samples].sort((left, right) => left - right);
    const measured = {
      samples: sorted,
      percentileMethod: 'ceil',
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      candidateCount,
      cacheHits,
      cacheHitRate: (cacheHits / samples.length).toFixed(5),
      decisionFailures,
      addedInferenceOverheadMs: shadowOverheadMs,
      providerCallsDuringRank: mock.hits.length - before,
      providerCallsDuringShadowChat: shadowProviderCalls,
    };
    expect(measured.candidateCount).toBe(8);
    expect(measured.providerCallsDuringRank).toBe(0);
    expect(measured.providerCallsDuringShadowChat).toBe(1);
    expect(measured.decisionFailures).toBe(0);
    expect(measured.cacheHits).toBe(39);
    expect(measured.addedInferenceOverheadMs).toBeGreaterThanOrEqual(0);
    console.log(`EVIDENCE performance ${JSON.stringify(measured)}`);
  });
});
