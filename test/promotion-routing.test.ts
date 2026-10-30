import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assignCohort } from '../src/inference/canary-assignment.js';
import { evaluatePromotionGates, PROMOTION_GATES, type PromotionFacts } from '../src/inference/promotion-gate.js';
import { proposeFromSnapshot } from '../src/inference/promotion-store.js';
import { runPromotionPass } from '../src/inference/promotion-worker.js';
import { withTenant } from '../src/db/tenant-context.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { startMockUpstream } from './mock-openai.js';

const HASH = 'ab'.repeat(32);
const EFFECTIVE = '2026-01-01T00:00:00.000Z';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-08f');
const SECRET = 'PROMOTE_SECRET_PROMPT';

type Tenant = ReturnType<typeof provisionTenant>;
type App = Awaited<ReturnType<typeof createTestApp>>;
type Rollout = { id: string; epoch: number; versionId: string };
type GateName = (typeof PROMOTION_GATES)[number];

function passingFacts(patch: Partial<PromotionFacts> = {}): PromotionFacts {
  return {
    evidenceStatus: 'qualified',
    reasonCodes: [],
    evidenceFresh: true,
    modelVersionMatches: true,
    configVersionMatches: true,
    matchedPairs: 20,
    minMatchedPairs: 20,
    wilsonLower: 0.95,
    qualityMinPassRate: 0.9,
    noninferiorityRequired: true,
    differenceLower: 0,
    noninferiorityMargin: 0.05,
    canarySamples: 2,
    minCanarySamples: 1,
    reliability: 1,
    reliabilityTarget: 0.99,
    latencyP95Ms: 40,
    maxLatencyMs: 4000,
    canaryCost: 0.01,
    baselineCost: 0.05,
    maxCostPerRequest: 0.05,
    budgetValid: true,
    providerValid: true,
    unresolvedCritical: false,
    ...patch,
  };
}

describe('promotion gate contract', () => {
  it('names every required gate and rejects the first failure', () => {
    const pass = evaluatePromotionGates(passingFacts());
    const failures: Record<string, string> = {
      unstable_judge: evaluatePromotionGates(passingFacts({ reasonCodes: ['judge_order_bias'] })).pass
        ? 'pass'
        : (evaluatePromotionGates(passingFacts({ reasonCodes: ['judge_order_bias'] })) as { gate: string }).gate,
      qualified_evidence: gateOf(passingFacts({ evidenceStatus: 'inconclusive', reasonCodes: ['insufficient_samples'] })),
      fresh_model_version: gateOf(passingFacts({ modelVersionMatches: false })),
      fresh_config_version: gateOf(passingFacts({ configVersionMatches: false })),
      matched_samples: gateOf(passingFacts({ matchedPairs: 1 })),
      quality_threshold: gateOf(passingFacts({ wilsonLower: 0.5 })),
      noninferiority: gateOf(passingFacts({ differenceLower: -0.5 })),
      reliability_target: gateOf(passingFacts({ reliability: 0.5 })),
      latency_target: gateOf(passingFacts({ latencyP95Ms: 50_000 })),
      cost_objective: gateOf(passingFacts({ canaryCost: 0.05, baselineCost: 0.05 })),
      canary_window: gateOf(passingFacts({ canarySamples: 0, reliability: null, latencyP95Ms: null, canaryCost: null, baselineCost: null })),
      budget_policy: gateOf(passingFacts({ budgetValid: false })),
      provider_policy: gateOf(passingFacts({ providerValid: false })),
      critical_incident: gateOf(passingFacts({ unresolvedCritical: true })),
    };
    expect(pass).toEqual({ pass: true });
    expect(PROMOTION_GATES.every((name) => failures[name] === name)).toBe(true);
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, 'promotion-policy-contract.json'),
      `${JSON.stringify({ gates: PROMOTION_GATES, pass: true, failures }, null, 2)}\n`,
    );
  });
});

function gateOf(facts: PromotionFacts): string {
  const result = evaluatePromotionGates(facts);
  return result.pass ? 'pass' : result.gate;
}

describe('governed promotion', () => {
  const db = loadTestDatabase();
  const scripts = new Map<string, 'ok' | '500'>();
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: App;
  let admin: pg.Pool;
  let tenant: Tenant;
  let other: Tenant;
  let policyId = '';
  let snapshotId = '';
  let profileVersionId = '';
  let spareConfig = 1;
  let baseId = '';
  let spareId = '';
  let policyVersionId = '';
  let sequence = 0;
  let priceStamp = Date.parse('2026-08-01T00:00:00.000Z');
  const cases: Record<string, unknown> = {};

  function cli(target: TestDatabase, args: string[]): Record<string, unknown> {
    return runCli(target, args, cliEnv()) as Record<string, unknown>;
  }

  function nextKey(name: string): string {
    sequence += 1;
    return `p${sequence}-${name}`;
  }

  function auth(caller: Tenant, idempotencyKey?: string, routingKey?: string): Record<string, string> {
    return {
      'x-tenant-id': caller.tenantId,
      authorization: `Bearer ${caller.secret}`,
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      ...(routingKey === undefined ? {} : { 'x-llm-routing-key': routingKey }),
    };
  }

  function keyFor(versionId: string, checks: Array<{ basis: number; want: 'baseline' | 'canary' }>): string {
    for (let index = 0; index < 8_000; index += 1) {
      const routingKey = `share-${index}`;
      const matched = checks.every(
        (check) =>
          assignCohort({
            tenantId: tenant.tenantId,
            alias: 'auto',
            policyVersionId: versionId,
            routingKey,
            basisPoints: check.basis,
          }) === check.want,
      );
      if (matched) return routingKey;
    }
    throw new Error('no routing key');
  }

  async function stopActive(): Promise<void> {
    const rows = await admin.query<{ id: string; epoch: number }>(
      `SELECT id::text AS id, epoch FROM routing_rollouts WHERE tenant_id = $1 AND status = 'active'`,
      [tenant.tenantId],
    );
    const row = rows.rows[0];
    if (row === undefined) return;
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${row.id}/stop`,
      headers: auth(tenant, `stop-${row.id}-${sequence}`),
      payload: { expectedEpoch: Number(row.epoch) },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
  }

  async function restoreCatalog(): Promise<void> {
    await admin.query(
      `UPDATE model_deployments
       SET upstream_model = CASE name WHEN 'promote-spare' THEN 'gpt-promote-spare' ELSE 'gpt-promote-base' END,
           config_version = CASE name WHEN 'promote-spare' THEN $2 ELSE config_version END,
           validation_status = 'validated_live'
       WHERE tenant_id = $1 AND name = ANY($3::text[])`,
      [tenant.tenantId, spareConfig, ['promote-base', 'promote-spare']],
    );
    await admin.query(`DELETE FROM tenant_budgets WHERE tenant_id = $1`, [tenant.tenantId]);
    await admin.query(`UPDATE model_aliases SET fallback_policy_id = NULL WHERE tenant_id = $1 AND alias = 'auto'`, [
      tenant.tenantId,
    ]);
  }

  function priceSpare(rate: string): void {
    priceStamp += 86_400_000;
    cli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-promote-spare',
      '--effective-at', new Date(priceStamp).toISOString(), '--source', 'fixture', '--status', 'verified',
      '--input-rate', rate,
    ]);
  }

  async function qualify(name: string, candidate: string, model: string, configVersion: number): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/qualification-profiles',
      headers: auth(tenant, nextKey(name)),
      payload: {
        name,
        taskCategory: 'general_qa',
        complexity: 'low',
        inputSizeCategory: 'xs',
        outputRequirementId,
        requiredCapabilities: ['temperature'],
        candidateDeployment: candidate,
        modelVersion: model,
        deploymentConfigVersion: configVersion,
        adapterVersion: 1,
        minSamples: 1,
        objectiveFloor: '0.80000',
        maxIntervalWidth: '0.20000',
        noninferiorityMargin: '0.05000',
        freshnessSeconds: 86_400,
        minCoverage: '1.00000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { versionId: string }).versionId;
  }

  let outputRequirementId = '';

  async function insertSnapshot(
    versionId: string,
    name: string,
    patch: { matched?: number; status?: string; reasons?: string[]; wilson?: number | null; difference?: number | null } = {},
  ): Promise<string> {
    const status = patch.status ?? 'qualified';
    const reasons = patch.reasons ?? [];
    const wilson = patch.wilson === undefined ? 0.9 : patch.wilson;
    const difference = patch.difference === undefined ? 0 : patch.difference;
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO evidence_snapshots (
         tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
         idempotency_key, request_hash, created_at
       ) VALUES ($1, $2, '{}'::uuid[], 1, $3, $4, $5, statement_timestamp())
       RETURNING id::text AS id`,
      [tenant.tenantId, versionId, patch.matched ?? 20, nextKey(name), HASH],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('snapshot was not stored');
    await admin.query(
      `INSERT INTO evidence_candidate_assessments (
         tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
         challenger_passes, challenger_trials, original_passes, original_trials
       ) VALUES ($1, $2, $3, $4::text[], $5, $6, $7, 20, 20, 20, 20)`,
      [tenant.tenantId, id, status, reasons, wilson, wilson === null ? null : 1, difference],
    );
    return id;
  }

  async function activate(basisPoints = 5_000, evidence = snapshotId): Promise<Rollout> {
    await stopActive();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('activate')),
      payload: {
        policyId,
        basisPoints,
        maxRequestCount: 1_000,
        maxExpense: '5',
        maxDurationSeconds: 86_400,
        evidenceSnapshotId: evidence,
        criticalErrorThreshold: 10_000,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as Rollout;
  }

  async function chat(routingKey: string | undefined, content: string, extra: Record<string, unknown> = {}, model = 'auto') {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(tenant, undefined, routingKey),
      payload: chatPayload(model, content, { task: 'general_qa', ...extra }),
    });
  }

  async function promote(rolloutId: string, payload: Record<string, unknown>, key = nextKey('promote'), caller = tenant) {
    return ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rolloutId}/promote`,
      headers: auth(caller, key),
      payload,
    });
  }

  async function cover(rollout: Rollout): Promise<void> {
    const canaryKey = keyFor(rollout.versionId, [{ basis: 5_000, want: 'canary' }]);
    const baseKey = keyFor(rollout.versionId, [{ basis: 5_000, want: 'baseline' }]);
    const canary = await chat(canaryKey, 'canary sample');
    expect(canary.statusCode, canary.body).toBe(200);
    expect(canary.headers['x-deployment']).toBe('promote-spare');
    const base = await chat(baseKey, 'baseline sample');
    expect(base.statusCode, base.body).toBe(200);
    expect(base.headers['x-deployment']).toBe('promote-base');
  }

  async function readPolicy(caller = tenant) {
    return ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies/${policyId}`,
      headers: auth(caller),
    });
  }

  async function readDecision(requestId: string, caller = tenant) {
    return ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${requestId}`,
      headers: auth(caller),
    });
  }

  function errorOf(response: { json: () => unknown }): { code: string; param: string | null } {
    const body = response.json() as { error: { code: string; param: string | null } };
    return body.error;
  }

  async function servingCount(): Promise<number> {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function versionRow(): Promise<{ id: string; rate: string; latency: number; segments: string[] }> {
    const result = await admin.query<{ id: string; rate: string; latency: number; segments: string[] }>(
      `SELECT id::text AS id, quality_min_pass_rate::text AS rate, max_latency_ms AS latency, task_segments AS segments
       FROM routing_policy_versions WHERE id = $1`,
      [policyVersionId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('policy version was not stored');
    return row;
  }

  beforeAll(async () => {
    mock = await startMockUpstream((_hit, _request, response) => {
      const parsed = JSON.parse(_hit.body) as { model?: string };
      const model = parsed.model ?? '';
      const script = scripts.get(model) ?? 'ok';
      if (script === '500') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-promote',
          object: 'chat.completion',
          created: 1_700_000_000,
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: `from-${model}` }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    });
    tenant = provisionTenant(db, 'Promote A');
    other = provisionTenant(db, 'Promote B');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-promote-a',
      deployment: 'promote-base',
      upstreamModel: 'gpt-promote-base',
    });
    cli(db, [
      'register-deployment', '--tenant-id', tenant.tenantId, '--name', 'promote-spare',
      '--upstream-model', 'gpt-promote-spare', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-promote-b',
      deployment: 'promote-beta',
      upstreamModel: 'gpt-promote-beta',
    });
    for (const name of ['promote-base', 'promote-spare']) {
      cli(db, ['set-deployment-data-collection', '--tenant-id', tenant.tenantId, '--deployment', name, '--data-collection', 'allow']);
      cli(db, ['set-deployment-context-limit', '--tenant-id', tenant.tenantId, '--deployment', name, '--context-limit', '128']);
      cli(db, ['set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', name, '--enabled', 'false']);
    }
    cli(db, [
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'promote-spare',
      '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
      '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    cli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-promote-base',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.05',
    ]);
    cli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-promote-spare',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.01',
    ]);
    admin = adminPool(db);
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = ANY($2::text[])`,
      [tenant.tenantId, ['promote-base', 'promote-spare']],
    );
    const config = await admin.query<{ config_version: number; id: string; name: string }>(
      `SELECT config_version, id::text AS id, name FROM model_deployments WHERE tenant_id = $1 AND name = ANY($2::text[])`,
      [tenant.tenantId, ['promote-base', 'promote-spare']],
    );
    spareConfig = Number(config.rows.find((row) => row.name === 'promote-spare')?.config_version ?? 0);
    baseId = config.rows.find((row) => row.name === 'promote-base')?.id ?? '';
    spareId = config.rows.find((row) => row.name === 'promote-spare')?.id ?? '';
    expect(spareConfig).toBeGreaterThan(0);
    expect(baseId).not.toBe('');
    expect(spareId).not.toBe('');
    ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [tenant.tenantId, tenant.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [tenant.tenantId, tenant.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [other.tenantId, other.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [other.tenantId, other.keyId]);
    const profile = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: auth(tenant),
      payload: {
        name: 'promote-extract',
        taskCategory: 'extraction',
        config: { limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 }, validators: [{ id: 'json_parse', version: 1 }] },
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const createdProfile = profile.json() as { id: string; version: number; versionId: string };
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${createdProfile.id}/versions/${createdProfile.version}/approve`,
      headers: auth(tenant),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    outputRequirementId = createdProfile.versionId;
    profileVersionId = await qualify('qp-promote-main', 'promote-spare', 'gpt-promote-spare', spareConfig);
    snapshotId = await insertSnapshot(profileVersionId, 'main');
    const policy = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(tenant, nextKey('policy')),
      payload: {
        name: 'promote-shadow',
        alias: 'auto',
        baselineDeployment: 'promote-base',
        candidateDeployments: ['promote-base', 'promote-spare'],
        qualityMinPassRate: '0.90000',
        qualityMinValidPairs: 20,
        maxCostPerRequest: '0.05000000',
        maxLatencyMs: 4000,
        taskSegments: ['general_qa', 'coding'],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    policyId = (policy.json() as { id: string }).id;
    const validated = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policyId}/validate`,
      headers: auth(tenant, nextKey('validate')),
      payload: { expectedEpoch: 1 },
    });
    expect(validated.statusCode, validated.body).toBe(200);
    const shadowed = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policyId}/status`,
      headers: auth(tenant, nextKey('shadow')),
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(shadowed.statusCode, shadowed.body).toBe(200);
    const activation = await admin.query<{ version_id: string }>(
      `SELECT version_id::text AS version_id FROM routing_policy_activations WHERE policy_id = $1`,
      [policyId],
    );
    policyVersionId = activation.rows[0]?.version_id ?? '';
    expect(policyVersionId).not.toBe('');
  });

  afterEach(async () => {
    scripts.clear();
    await stopActive();
    await restoreCatalog();
    priceSpare('0.01');
    await admin.query(`DELETE FROM routing_auto_promotion_policies WHERE tenant_id = $1`, [tenant.tenantId]);
    snapshotId = await insertSnapshot(profileVersionId, 'fresh');
  });

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'gate-verification.json'), `${JSON.stringify(cases.gates ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'activation-history.json'), `${JSON.stringify(cases.activation ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'routing-decisions.json'), `${JSON.stringify(cases.decisions ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'policy-refresh.json'), `${JSON.stringify(cases.refresh ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'conflict-rollback.json'), `${JSON.stringify(cases.conflict ?? {}, null, 2)}\n`);
    writeFileSync(join(EVIDENCE, 'tenant-isolation.json'), `${JSON.stringify(cases.isolation ?? {}, null, 2)}\n`);
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await mock.close();
  });

  it('rejects insufficient live canary coverage', async () => {
    const rollout = await activate();
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('canary_window');
    expect(await servingCount()).toBe(0);
    cases.gates = { ...(cases.gates as object), canary_window: errorOf(response).param };
  });

  it('rejects unstable judge evidence', async () => {
    const weak = await insertSnapshot(profileVersionId, 'judge', {
      status: 'inconclusive',
      reasons: ['judge_order_bias'],
      wilson: null,
      difference: null,
    });
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO routing_rollouts (
         tenant_id, policy_id, version_id, alias, basis_points, max_request_count, max_expense,
         max_duration_seconds, evidence_snapshot_id, baseline_deployment_id, challenger_deployment_id,
         critical_error_threshold, epoch, status, idempotency_key, request_hash
       ) VALUES (
         $1, $2, $3, 'auto', 5000, 1000, 5, 86400, $4, $5, $6, 10000, 1, 'active', $7, $8
       ) RETURNING id::text AS id`,
      [tenant.tenantId, policyId, policyVersionId, weak, baseId, spareId, nextKey('judge-rollout'), HASH],
    );
    const rolloutId = inserted.rows[0]?.id ?? '';
    const response = await promote(rolloutId, { expectedEpoch: 1, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('unstable_judge');
    expect(await servingCount()).toBe(0);
    cases.gates = { ...(cases.gates as object), unstable_judge: 'unstable_judge' };
  });

  it('rejects a quality gate that is not passed', async () => {
    const weak = await insertSnapshot(profileVersionId, 'quality', { wilson: 0.5 });
    const rollout = await activate(5_000, weak);
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('quality_threshold');
    cases.gates = { ...(cases.gates as object), quality_threshold: 'quality_threshold' };
  });

  it('rejects a stale model version', async () => {
    const rollout = await activate();
    await admin.query(`UPDATE model_deployments SET upstream_model = 'gpt-promote-stale' WHERE id = $1`, [spareId]);
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('fresh_model_version');
    cases.gates = { ...(cases.gates as object), fresh_model_version: 'fresh_model_version' };
  });

  it('rejects old evidence after a deployment update', async () => {
    const rollout = await activate();
    await admin.query(`UPDATE model_deployments SET config_version = config_version + 1 WHERE id = $1`, [spareId]);
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('fresh_config_version');
    cases.gates = { ...(cases.gates as object), fresh_config_version: 'fresh_config_version' };
  });

  it('rejects a latency regression', async () => {
    const rollout = await activate();
    await cover(rollout);
    const updated = await admin.query(
      `UPDATE model_attempts attempt
       SET duration_ms = 50000
       FROM routing_canary_assignments assignment
       WHERE assignment.rollout_id = $1 AND assignment.cohort = 'canary'
         AND attempt.tenant_id = assignment.tenant_id
         AND attempt.request_id = assignment.request_id
         AND attempt.deployment_id = assignment.cohort_deployment_id`,
      [rollout.id],
    );
    expect(updated.rowCount ?? 0).toBeGreaterThan(0);
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('latency_target');
    cases.gates = { ...(cases.gates as object), latency_target: 'latency_target' };
  });

  it('rejects a cost improvement that is not established', async () => {
    priceSpare('0.20');
    const rollout = await activate();
    await cover(rollout);
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).param).toBe('cost_objective');
    cases.gates = { ...(cases.gates as object), cost_objective: 'cost_objective' };
  });

  it('rejects promotion during rollback', async () => {
    const rollout = await activate();
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
      headers: auth(tenant, nextKey('stop-first')),
      payload: { expectedEpoch: rollout.epoch },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const response = await promote(rollout.id, { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000] });
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).code).toBe('promotion_during_rollback');
    expect(await servingCount()).toBe(0);
    cases.conflict = { ...(cases.conflict as object), duringRollback: errorOf(response).code };
  });

  it('rejects a new key that repeats the create epoch', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
    });
    expect(created.statusCode, created.body).toBe(201);
    const promotion = created.json() as {
      activationEpoch: number;
      basisPoints: number;
      stageIndex: number;
      stages: number[];
      previousPolicyVersionId: string | null;
    };
    expect(promotion.stages).toEqual([100, 500, 2500, 5000, 10000]);
    expect(promotion.basisPoints).toBe(100);
    expect(promotion.stageIndex).toBe(1);
    expect(promotion.activationEpoch).toBe(rollout.epoch + 1);
    expect(promotion.previousPolicyVersionId).toBeNull();
    const retry = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
    });
    expect(retry.statusCode, retry.body).toBe(409);
    expect(errorOf(retry).code).toBe('stale_activation');
    const policy = await readPolicy();
    const stored = (policy.json() as { promotion: { basisPoints: number; stageIndex: number; activationEpoch: number } }).promotion;
    expect(stored.basisPoints).toBe(100);
    expect(stored.stageIndex).toBe(1);
    expect(stored.activationEpoch).toBe(promotion.activationEpoch);
    cases.activation = {
      ...(cases.activation as object),
      createEpoch: {
        submitted: rollout.epoch,
        stored: promotion.activationEpoch,
        retry: errorOf(retry).code,
        basisPoints: stored.basisPoints,
      },
    };
  });

  it('promotes one qualified policy and advances only when the gates pass again', async () => {
    const before = await versionRow();
    const rollout = await activate();
    await cover(rollout);
    const heldKey = keyFor(rollout.versionId, [{ basis: 200, want: 'baseline' }]);
    const selectedKey = keyFor(rollout.versionId, [{ basis: 800, want: 'canary' }]);
    const first = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'coding',
      stages: [200, 800],
      enableSelection: true,
    });
    expect(first.statusCode, first.body).toBe(400);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [200, 800],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const promotion = created.json() as {
      activationEpoch: number;
      basisPoints: number;
      stageIndex: number;
      stages: number[];
      selectionEnabled: boolean;
      policyVersionId: string;
      previousPolicyVersionId: string | null;
      rollbackDeployment: string;
      status: string;
      actor: string;
      events: Array<{ action: string; actor: string }>;
    };
    expect(promotion.basisPoints).toBe(200);
    expect(promotion.stageIndex).toBe(1);
    expect(promotion.stages).toEqual([200, 800]);
    expect(promotion.selectionEnabled).toBe(true);
    expect(promotion.policyVersionId).toBe(policyVersionId);
    expect(promotion.previousPolicyVersionId).toBe(policyVersionId);
    expect(promotion.rollbackDeployment).toBe('promote-base');
    expect(promotion.actor).toBe('operator');
    expect(promotion.events.map((event) => event.action)).toEqual(['promote']);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const paused = await readPolicy();
    expect(paused.statusCode, paused.body).toBe(200);
    const pausedBody = paused.json() as { promotion: { basisPoints: number; stageIndex: number }; events: Array<{ status: string }> };
    expect(pausedBody.promotion.basisPoints).toBe(200);
    expect(pausedBody.events.map((event) => event.status)).toEqual(['draft', 'validated', 'shadow']);
    const held = await chat(heldKey, 'held segment');
    expect(held.statusCode, held.body).toBe(200);
    expect(held.headers['x-deployment']).toBe('promote-base');
    const advanced = await promote(rollout.id, {
      expectedEpoch: promotion.activationEpoch,
      taskSegment: 'general_qa',
      stages: [200, 800],
      enableSelection: true,
    });
    expect(advanced.statusCode, advanced.body).toBe(200);
    const next = advanced.json() as { activationEpoch: number; basisPoints: number; stageIndex: number };
    expect(next.basisPoints).toBe(800);
    expect(next.stageIndex).toBe(2);
    const blocked = await promote(rollout.id, {
      expectedEpoch: next.activationEpoch,
      taskSegment: 'general_qa',
      stages: [200, 800],
      enableSelection: true,
    });
    expect(blocked.statusCode, blocked.body).toBe(409);
    expect(errorOf(blocked).code).toBe('activation_conflict');
    const after = await versionRow();
    expect(after).toEqual(before);
    const selected = await chat(selectedKey, SECRET);
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.headers['x-deployment']).toBe('promote-spare');
    expect((selected.json() as { model: string }).model).toBe('gpt-promote-spare');
    const again = await chat(selectedKey, SECRET);
    expect(again.headers['x-deployment']).toBe('promote-spare');
    const decision = await readDecision(String(selected.headers['x-request-id']));
    expect(decision.statusCode, decision.body).toBe(200);
    expect(decision.body).not.toContain(SECRET);
    expect(decision.body).not.toContain('from-gpt-promote-spare');
    const decisionBody = decision.json() as {
      routingMode: string;
      selectedDeployment: string;
      selection: { reason: string; selectedDeployment: string; baselineDeployment: string };
    };
    expect(decisionBody.routingMode).toBe('shadow');
    expect(decisionBody.selectedDeployment).toBe('promote-spare');
    expect(decisionBody.selection.reason).toBe('selected');
    expect(decisionBody.selection.baselineDeployment).toBe('promote-base');
    cases.activation = {
      ...(cases.activation as object),
      first: { basisPoints: 200, stageIndex: 1, actor: 'operator' },
      afterWait: { basisPoints: 200 },
      advanced: { basisPoints: 800, stageIndex: 2 },
      policyVersionUnchanged: before.id === after.id,
    };
    cases.decisions = {
      selected: { deployment: 'promote-spare', reason: 'selected', promptPresent: decision.body.includes(SECRET) },
      held: { deployment: String(held.headers['x-deployment']) },
    };
  });

  it('keeps a forced-model request on that deployment', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const named = await chat(undefined, 'named model', {}, 'promote-base');
    expect(named.statusCode, named.body).toBe(200);
    expect(named.headers['x-deployment']).toBe('promote-base');
    const decision = await readDecision(String(named.headers['x-request-id']));
    expect(decision.statusCode, decision.body).toBe(200);
    const body = decision.json() as { routingMode: string; selection: unknown };
    expect(body.routingMode).toBe('bypass');
    expect(body.selection).toBeNull();
    cases.decisions = { ...(cases.decisions as object), forced: { deployment: 'promote-base', selection: null } };
  });

  it('keeps active selection off until the operator enables it', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [100],
    });
    expect(created.statusCode, created.body).toBe(201);
    expect((created.json() as { selectionEnabled: boolean }).selectionEnabled).toBe(false);
    const routingKey = keyFor(rollout.versionId, [
      { basis: 5_000, want: 'canary' },
      { basis: 100, want: 'baseline' },
    ]);
    const response = await chat(routingKey, 'selection off');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe('promote-spare');
    const decision = await readDecision(String(response.headers['x-request-id']));
    expect((decision.json() as { selection: unknown }).selection).toBeNull();
  });

  it('uses the baseline when no qualified candidate remains', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    await insertSnapshot(profileVersionId, 'unqualified', {
      status: 'unqualified',
      reasons: ['objective_threshold_failed'],
      wilson: null,
      difference: null,
    });
    const response = await chat('fallback-key', 'no candidate');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe('promote-base');
    const decision = await readDecision(String(response.headers['x-request-id']));
    expect((decision.json() as { selection: { reason: string } }).selection.reason).toBe('baseline_fallback');
    cases.decisions = { ...(cases.decisions as object), noCandidate: 'baseline_fallback' };
  });

  it('returns baseline unavailable when the approved baseline is not permitted', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    await insertSnapshot(profileVersionId, 'unavailable', {
      status: 'unqualified',
      reasons: ['objective_threshold_failed'],
      wilson: null,
      difference: null,
    });
    await admin.query(`UPDATE model_deployments SET validation_status = 'unvalidated' WHERE id = $1`, [baseId]);
    const response = await chat('missing-base', 'no baseline');
    expect(response.statusCode, response.body).toBe(409);
    expect(errorOf(response).code).toBe('baseline_unavailable');
    cases.decisions = { ...(cases.decisions as object), baselineUnavailable: 'baseline_unavailable' };
  });

  it('routes another task segment to the baseline', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const response = await chat('coding-key', 'write code', { task: 'coding' });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['x-deployment']).toBe('promote-base');
    const decision = await readDecision(String(response.headers['x-request-id']));
    const selection = (decision.json() as { selection: { reason: string; taskSegment: string } }).selection;
    expect(selection.reason).toBe('segment_mismatch');
    expect(selection.taskSegment).toBe('coding');
    cases.decisions = { ...(cases.decisions as object), otherSegment: 'segment_mismatch' };
  });

  it('keeps the same routing key on the selected deployment', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = await chat('sticky-key', 'turn one');
    const second = await chat('sticky-key', 'turn two');
    expect(first.headers['x-deployment']).toBe('promote-spare');
    expect(second.headers['x-deployment']).toBe('promote-spare');
    const pins = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM routing_selection_pins pin
       WHERE pin.tenant_id = $1
         AND pin.routing_key_digest = (
           SELECT decision.routing_key_digest
           FROM routing_selection_decisions decision
           WHERE decision.request_id = $2
         )`,
      [tenant.tenantId, String(first.headers['x-request-id'])],
    );
    expect(Number(pins.rows[0]?.count ?? 0)).toBe(1);
  });

  it('does not move the pin when feedback arrives after promotion', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const promotion = created.json() as { policyVersionId: string; activationEpoch: number };
    const first = await chat('feedback-key', 'before feedback');
    expect(first.statusCode, first.body).toBe(200);
    const requestId = String(first.headers['x-request-id']);
    const early = await ctx.app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: auth(tenant),
      payload: {
        requestId,
        feedbackId: nextKey('fb'),
        source: 'task-verifier',
        metric: 'task_success',
        result: 'pass',
        validatorVersion: 'v1',
        timestamp: new Date().toISOString(),
      },
    });
    expect(early.statusCode).toBe(400);
    const attached = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/guardrails',
      headers: auth(tenant, nextKey('attach')),
      payload: {
        rolloutId: rollout.id,
        approvedSources: ['task-verifier'],
        rules: [{ kind: 'absolute_failure', signal: 'error_rate', threshold: 1, minSamples: 30, windowSeconds: 3600, maturitySeconds: 0, maxMissingFraction: 1, margin: 0 }],
      },
    });
    expect(attached.statusCode, attached.body).toBe(201);
    const stored = await ctx.app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: auth(tenant),
      payload: {
        requestId,
        feedbackId: nextKey('fb-ok'),
        source: 'task-verifier',
        metric: 'task_success',
        result: 'pass',
        validatorVersion: 'v1',
        timestamp: new Date().toISOString(),
      },
    });
    expect(stored.statusCode, stored.body).toBe(201);
    const policy = await readPolicy();
    const body = policy.json() as { promotion: { policyVersionId: string; activationEpoch: number } };
    expect(body.promotion.policyVersionId).toBe(promotion.policyVersionId);
    expect(body.promotion.activationEpoch).toBe(promotion.activationEpoch);
    const second = await chat('feedback-key', 'after feedback');
    expect(second.headers['x-deployment']).toBe('promote-spare');
  });

  it('drops a pin when newer evidence is no longer qualified', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const first = await chat('invalidate-key', 'before invalidation');
    expect(first.headers['x-deployment']).toBe('promote-spare');
    await insertSnapshot(profileVersionId, 'invalidated', {
      status: 'invalidated',
      reasons: ['expired_evidence'],
      wilson: null,
      difference: null,
    });
    const second = await chat('invalidate-key', 'after invalidation');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.headers['x-deployment']).toBe('promote-base');
    const decision = await readDecision(String(second.headers['x-request-id']));
    expect((decision.json() as { selection: { reason: string } }).selection.reason).toBe('baseline_fallback');
    cases.decisions = { ...(cases.decisions as object), invalidated: 'baseline_fallback' };
  });

  it('proposes a new candidate without changing the serving policy', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const before = await versionRow();
    cli(db, [
      'register-deployment', '--tenant-id', tenant.tenantId, '--name', 'promote-extra',
      '--upstream-model', 'gpt-promote-extra', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    cli(db, ['set-deployment-data-collection', '--tenant-id', tenant.tenantId, '--deployment', 'promote-extra', '--data-collection', 'allow']);
    cli(db, ['set-deployment-context-limit', '--tenant-id', tenant.tenantId, '--deployment', 'promote-extra', '--context-limit', '128']);
    await admin.query(`UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = 'promote-extra'`, [
      tenant.tenantId,
    ]);
    const extraConfig = await admin.query<{ config_version: number }>(
      `SELECT config_version FROM model_deployments WHERE tenant_id = $1 AND name = 'promote-extra'`,
      [tenant.tenantId],
    );
    const extraVersion = await qualify('qp-promote-extra', 'promote-extra', 'gpt-promote-extra', Number(extraConfig.rows[0]?.config_version ?? 0));
    const refreshed = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/evidence/refresh',
      headers: auth(tenant, nextKey('refresh-extra')),
      payload: { profileVersionId: extraVersion },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    const policy = await readPolicy();
    const body = policy.json() as {
      candidateDeployments: string[];
      promotion: { policyVersionId: string };
      proposals: Array<{ id: string; changeKind: string; gateName: string; candidateDeployment: string; status: string; requiresShadow: boolean; requiresCanary: boolean }>;
    };
    expect(body.candidateDeployments).toEqual(['promote-base', 'promote-spare']);
    expect(body.promotion.policyVersionId).toBe(before.id);
    const proposal = body.proposals.find((item) => item.candidateDeployment === 'promote-extra');
    expect(proposal?.changeKind).toBe('candidate');
    expect(proposal?.gateName).toBe('qualified_evidence');
    expect(proposal?.requiresShadow).toBe(true);
    expect(proposal?.requiresCanary).toBe(true);
    const qualifiedExtra = await insertSnapshot(extraVersion, 'extra-qualified');
    const qualifiedProposal = await withTenant(ctx.runtimePool, tenant.tenantId, (client) =>
      proposeFromSnapshot(client, tenant.tenantId, qualifiedExtra),
    );
    expect(qualifiedProposal?.changeKind).toBe('candidate');
    expect(qualifiedProposal?.gateName).toBe('canary_window');
    const rejected = await promote(rollout.id, { proposalId: proposal?.id });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect((rejected.json() as { status: string }).status).toBe('rejected');
    const after = await readPolicy();
    expect((after.json() as { promotion: { policyVersionId: string } }).promotion.policyVersionId).toBe(before.id);
    cases.refresh = {
      candidateDeployments: body.candidateDeployments,
      changeKind: proposal?.changeKind,
      gateName: proposal?.gateName,
      qualifiedGateName: qualifiedProposal?.gateName,
      rejected: true,
      policyVersionId: before.id,
    };
  });

  it('does not invent a cost proposal when the candidate is unchanged', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const before = await readPolicy();
    const beforeIds = new Set(
      (before.json() as { proposals: Array<{ id: string }> }).proposals.map((item) => item.id),
    );
    const first = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/evidence/refresh',
      headers: auth(tenant, nextKey('refresh-same')),
      payload: { profileVersionId },
    });
    expect(first.statusCode, first.body).toBe(201);
    const opened = await readPolicy();
    const openedBody = opened.json() as {
      promotion: { policyVersionId: string };
      proposals: Array<{ id: string; changeKind: string; gateName: string }>;
    };
    const added = openedBody.proposals.filter((item) => !beforeIds.has(item.id));
    expect(openedBody.promotion.policyVersionId).toBe(policyVersionId);
    expect(added).toHaveLength(1);
    expect(added[0]?.changeKind).toBe('quality');
    expect(added[0]?.gateName).toBe('qualified_evidence');
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/evidence/refresh',
      headers: auth(tenant, nextKey('refresh-same-again')),
      payload: { profileVersionId },
    });
    expect(second.statusCode, second.body).toBe(201);
    const again = await readPolicy();
    const againBody = again.json() as { proposals: Array<{ id: string; changeKind: string; gateName: string }> };
    const still = againBody.proposals.filter((item) => !beforeIds.has(item.id));
    expect(still).toHaveLength(1);
    expect(still.some((item) => item.changeKind === 'cost' || item.gateName === 'pass')).toBe(false);
    cases.refresh = {
      ...(cases.refresh as object),
      unchanged: { added: still.length, gateName: added[0]?.gateName },
    };
  });

  it('stores an open incident instead of a passing proposal', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    await admin.query(`UPDATE routing_rollouts SET critical_error_count = 1 WHERE id = $1`, [rollout.id]);
    const snapshot = await insertSnapshot(profileVersionId, 'incident-evidence', { wilson: 0.95 });
    const proposal = await withTenant(ctx.runtimePool, tenant.tenantId, (client) =>
      proposeFromSnapshot(client, tenant.tenantId, snapshot),
    );
    expect(proposal?.changeKind).toBe('quality');
    expect(proposal?.gateName).toBe('critical_incident');
    const policy = await readPolicy();
    const body = policy.json() as { promotion: { policyVersionId: string }; proposals: Array<{ gateName: string }> };
    expect(body.promotion.policyVersionId).toBe(policyVersionId);
    expect(body.proposals.some((item) => item.gateName === 'pass')).toBe(false);
    cases.refresh = {
      ...(cases.refresh as object),
      incident: proposal?.gateName,
    };
  });

  it('rejects a looser automatic margin that would hide a noninferiority failure', async () => {
    const weak = await insertSnapshot(profileVersionId, 'loose-margin', { difference: -0.1 });
    const rollout = await activate(5_000, weak);
    await cover(rollout);
    const manual = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
    });
    expect(manual.statusCode, manual.body).toBe(409);
    expect(errorOf(manual).param).toBe('noninferiority');
    expect(await servingCount()).toBe(0);
    const saved = await promote(rollout.id, {
      automaticPolicy: {
        enabled: true,
        approvedCandidateIds: [spareId],
        qualityMinPassRate: '0.80000',
        minValidPairs: 1,
        noninferiorityMargin: '0.20000',
        maxBasisPoints: 10_000,
        requireGuardrails: false,
        rollbackVerified: true,
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const pass = await runPromotionPass(ctx.runtimePool, [tenant.tenantId]);
    expect(pass.promoted).toBe(0);
    expect(await servingCount()).toBe(0);
    cases.gates = {
      ...(cases.gates as object),
      loose_margin: { manual: errorOf(manual).param, automaticPromoted: pass.promoted },
    };
  });

  it('rejects a promotion conflict and a reused idempotency key', async () => {
    const rollout = await activate();
    await cover(rollout);
    const payload = { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000], enableSelection: false };
    const key = nextKey('conflict');
    const created = await promote(rollout.id, payload, key);
    expect(created.statusCode, created.body).toBe(201);
    const replay = await promote(rollout.id, payload, key);
    expect(replay.statusCode, replay.body).toBe(200);
    const reused = await promote(rollout.id, { ...payload, enableSelection: true }, key);
    expect(reused.statusCode, reused.body).toBe(409);
    expect(errorOf(reused).code).toBe('idempotency_conflict');
    const stale = await promote(rollout.id, { ...payload, expectedEpoch: 99 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale).code).toBe('stale_activation');
    expect(await servingCount()).toBe(1);
    cases.conflict = {
      ...(cases.conflict as object),
      replay: replay.statusCode,
      reused: errorOf(reused).code,
      stale: errorOf(stale).code,
      serving: 1,
    };
  });

  it('keeps one serving policy when two promotions race', async () => {
    const rollout = await activate();
    await cover(rollout);
    const payload = { expectedEpoch: rollout.epoch, taskSegment: 'general_qa', stages: [10_000], enableSelection: false };
    const [left, right] = await Promise.all([
      promote(rollout.id, payload, nextKey('race-a')),
      promote(rollout.id, payload, nextKey('race-b')),
    ]);
    const statuses = [left.statusCode, right.statusCode].sort((a, b) => a - b);
    expect(statuses).toEqual([201, 409]);
    expect(await servingCount()).toBe(1);
    const policy = await readPolicy();
    expect((policy.json() as { promotion: { stageIndex: number; basisPoints: number } }).promotion.stageIndex).toBe(1);
    expect((policy.json() as { promotion: { basisPoints: number } }).promotion.basisPoints).toBe(10_000);
    cases.conflict = { ...(cases.conflict as object), concurrent: statuses, serving: 1 };
  });

  it('rolls back to the stored target after full activation', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const selected = await chat('full-key', 'full share');
    expect(selected.headers['x-deployment']).toBe('promote-spare');
    const rolled = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(tenant, nextKey('rollback')),
      payload: { expectedEpoch: rollout.epoch },
    });
    expect(rolled.statusCode, rolled.body).toBe(200);
    expect((rolled.json() as { rollout: { stopReason: string } }).rollout.stopReason).toBe('critical_errors');
    const next = await chat('after-rollback', 'back to baseline');
    expect(next.statusCode, next.body).toBe(200);
    expect(next.headers['x-deployment']).toBe('promote-base');
    expect(await servingCount()).toBe(0);
    const violations = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_guardrail_violations WHERE rollout_id = $1`,
      [rollout.id],
    );
    expect(Number(violations.rows[0]?.count ?? 0)).toBe(1);
    cases.conflict = { ...(cases.conflict as object), rollback: { next: 'promote-base', violations: 1, serving: 0 } };
  });

  it('preserves the emergency stop', async () => {
    const rollout = await activate();
    await cover(rollout);
    await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
      headers: auth(tenant, nextKey('emergency')),
      payload: { expectedEpoch: rollout.epoch },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect((stopped.json() as { stopReason: string }).stopReason).toBe('manual');
    const violations = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_guardrail_violations WHERE rollout_id = $1`,
      [rollout.id],
    );
    expect(Number(violations.rows[0]?.count ?? 0)).toBe(0);
    const next = await chat('after-stop', 'stopped');
    expect(next.headers['x-deployment']).toBe('promote-base');
    expect(await servingCount()).toBe(0);
  });

  it('rejects a canary that asks to promote itself', async () => {
    const rollout = await activate();
    const response = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(tenant, nextKey('self')),
      payload: { expectedEpoch: rollout.epoch, promote: true },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(errorOf(response).code).toBe('promotion_rejected');
    const status = await admin.query<{ status: string }>(`SELECT status FROM routing_rollouts WHERE id = $1`, [rollout.id]);
    expect(status.rows[0]?.status).toBe('active');
  });

  it('isolates promotion to the owning tenant and stores no prompt', async () => {
    const rollout = await activate();
    await cover(rollout);
    const created = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    });
    expect(created.statusCode, created.body).toBe(201);
    const foreign = await promote(rollout.id, {
      expectedEpoch: rollout.epoch,
      taskSegment: 'general_qa',
      stages: [10_000],
      enableSelection: true,
    }, nextKey('foreign'), other);
    expect(foreign.statusCode, foreign.body).toBe(404);
    const foreignPolicy = await readPolicy(other);
    expect(foreignPolicy.statusCode).toBe(404);
    const chatResponse = await chat('isolation-key', SECRET);
    const decision = await readDecision(String(chatResponse.headers['x-request-id']));
    const foreignDecision = await readDecision(String(chatResponse.headers['x-request-id']), other);
    expect(foreignDecision.statusCode).toBe(404);
    const policy = await readPolicy();
    expect(policy.body).not.toContain(SECRET);
    expect(decision.body).not.toContain(SECRET);
    expect(created.body).not.toContain(SECRET);
    const filtered = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies?tenantId=${other.tenantId}`,
      headers: auth(tenant),
    });
    expect((filtered.json() as { policies: unknown[] }).policies).toEqual([]);
    cases.isolation = {
      foreignPromote: foreign.statusCode,
      foreignPolicy: foreignPolicy.statusCode,
      foreignDecision: foreignDecision.statusCode,
      promptInPolicy: policy.body.includes(SECRET),
      promptInDecision: decision.body.includes(SECRET),
    };
  });

  it('leaves automatic promotion off until the operator approves a candidate', async () => {
    const idle = await runPromotionPass(ctx.runtimePool, [tenant.tenantId]);
    expect(idle.promoted).toBe(0);
    const before = await readPolicy();
    expect((before.json() as { automaticPromotion: unknown }).automaticPromotion).toBeNull();
    const disabled = await promote(snapshotId, {
      automaticPolicy: {
        enabled: false,
        approvedCandidateIds: [],
        qualityMinPassRate: '0.95000',
        minValidPairs: 20,
        noninferiorityMargin: '0.05000',
        maxBasisPoints: 100,
        requireGuardrails: true,
        rollbackVerified: false,
      },
    });
    expect(disabled.statusCode, disabled.body).toBe(404);
    const rollout = await activate();
    const savedOff = await promote(rollout.id, {
      automaticPolicy: {
        enabled: false,
        approvedCandidateIds: [spareId],
        qualityMinPassRate: '0.95000',
        minValidPairs: 20,
        noninferiorityMargin: '0.05000',
        maxBasisPoints: 100,
        requireGuardrails: true,
        rollbackVerified: true,
      },
    });
    expect(savedOff.statusCode, savedOff.body).toBe(200);
    expect((savedOff.json() as { automaticPromotion: { enabled: boolean } }).automaticPromotion.enabled).toBe(false);
    await cover(rollout);
    expect((await runPromotionPass(ctx.runtimePool, [tenant.tenantId])).promoted).toBe(0);
    const wrong = await promote(rollout.id, {
      automaticPolicy: {
        enabled: true,
        approvedCandidateIds: [baseId],
        qualityMinPassRate: '0.80000',
        minValidPairs: 1,
        noninferiorityMargin: '0.05000',
        maxBasisPoints: 100,
        requireGuardrails: true,
        rollbackVerified: true,
      },
    });
    expect(wrong.statusCode, wrong.body).toBe(200);
    expect((await runPromotionPass(ctx.runtimePool, [tenant.tenantId])).promoted).toBe(0);
    expect(await servingCount()).toBe(0);
    const unguarded = await promote(rollout.id, {
      automaticPolicy: {
        enabled: true,
        approvedCandidateIds: [spareId],
        qualityMinPassRate: '0.80000',
        minValidPairs: 1,
        noninferiorityMargin: '0.05000',
        maxBasisPoints: 100,
        requireGuardrails: true,
        rollbackVerified: true,
      },
    });
    expect(unguarded.statusCode).toBe(200);
    expect((await runPromotionPass(ctx.runtimePool, [tenant.tenantId])).promoted).toBe(0);
    const attached = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/guardrails',
      headers: auth(tenant, nextKey('auto-guard')),
      payload: {
        rolloutId: rollout.id,
        approvedSources: ['task-verifier'],
        rules: [{ kind: 'absolute_failure', signal: 'error_rate', threshold: 1, minSamples: 30, windowSeconds: 3600, maturitySeconds: 0, maxMissingFraction: 1, margin: 0 }],
      },
    });
    expect(attached.statusCode, attached.body).toBe(201);
    const strict = await promote(rollout.id, {
      automaticPolicy: {
        enabled: true,
        approvedCandidateIds: [spareId],
        qualityMinPassRate: '0.99000',
        minValidPairs: 20,
        noninferiorityMargin: '0.05000',
        maxBasisPoints: 100,
        requireGuardrails: true,
        rollbackVerified: true,
      },
    });
    expect(strict.statusCode).toBe(200);
    expect((await runPromotionPass(ctx.runtimePool, [tenant.tenantId])).promoted).toBe(0);
    const approved = await promote(rollout.id, {
      automaticPolicy: {
        enabled: true,
        approvedCandidateIds: [spareId],
        qualityMinPassRate: '0.80000',
        minValidPairs: 1,
        noninferiorityMargin: '0.05000',
        maxBasisPoints: 100,
        requireGuardrails: true,
        rollbackVerified: true,
      },
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const pass = await runPromotionPass(ctx.runtimePool, [tenant.tenantId]);
    expect(pass.promoted).toBe(1);
    const policy = await readPolicy();
    const promotion = (policy.json() as {
      promotion: { actor: string; basisPoints: number; selectionEnabled: boolean; stageIndex: number };
    }).promotion;
    expect(promotion.actor).toBe('automatic');
    expect(promotion.basisPoints).toBe(100);
    expect(promotion.selectionEnabled).toBe(false);
    expect(promotion.stageIndex).toBe(1);
    const second = await runPromotionPass(ctx.runtimePool, [tenant.tenantId]);
    expect(second.promoted).toBe(0);
    const still = await readPolicy();
    expect((still.json() as { promotion: { basisPoints: number } }).promotion.basisPoints).toBe(100);
    cases.activation = {
      ...(cases.activation as object),
      automatic: { actor: 'automatic', basisPoints: 100, selectionEnabled: false, secondPass: 0 },
    };
  });

  it('keeps the proxy process and the image command free of the promotion worker', () => {
    const indexSource = readFileSync(join(projectRoot, 'src/index.ts'), 'utf8');
    const docker = readFileSync(join(projectRoot, 'Dockerfile'), 'utf8');
    const worker = readFileSync(join(projectRoot, 'src/promotion-worker.ts'), 'utf8');
    const pass = readFileSync(join(projectRoot, 'src/inference/promotion-worker.ts'), 'utf8');
    expect(indexSource.includes('promotion-worker')).toBe(false);
    expect(docker).toContain('CMD ["node", "dist/index.js"]');
    expect(docker.includes('promotion-worker')).toBe(false);
    expect(worker.includes('Bearer')).toBe(false);
    expect(worker.toLowerCase().includes('authorization')).toBe(false);
    expect(pass.includes('Bearer')).toBe(false);
    expect(worker.includes('sk-')).toBe(false);
    const child = spawnSync(process.execPath, ['dist/promotion-worker.js'], {
      cwd: projectRoot,
      env: { ...serviceEnv(db), PROMOTION_ONCE: 'true', PROMOTION_TENANTS: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(`${child.stdout}\n${child.stderr}`).not.toMatch(/Bearer|sk-[A-Za-z0-9_-]+/);
  });
});
