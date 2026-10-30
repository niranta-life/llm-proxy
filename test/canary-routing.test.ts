import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { assignCohort, routingKeyDigest } from '../src/inference/canary-assignment.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli, type TestDatabase } from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { startMockUpstream, type MockHit } from './mock-openai.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const VERSION_A = '22222222-2222-4222-8222-222222222222';
const VERSION_B = '33333333-3333-4333-8333-333333333333';
const HASH = 'ab'.repeat(32);
const EFFECTIVE = '2025-12-01T00:00:00.000Z';

type Script = 'ok' | '500' | '503' | 'partial';
type Tenant = ReturnType<typeof provisionTenant>;
type App = Awaited<ReturnType<typeof createTestApp>>;

const PARTIAL = `data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":1,"model":"gpt-canary-spare","choices":[{"index":0,"delta":{"role":"assistant","content":"partial-canary"},"finish_reason":null}]}\n\n`;

function auth(tenant: Tenant, idempotencyKey?: string, routingKey?: string): Record<string, string> {
  return {
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
    'content-type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    ...(routingKey === undefined ? {} : { 'x-llm-routing-key': routingKey }),
  };
}

function sseBody(model: string): string {
  const head = { id: 'chatcmpl-canary', object: 'chat.completion.chunk', created: 1_700_000_000, model };
  return [
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { content: 'from-canary' }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function modelOf(hit: MockHit): string {
  return (JSON.parse(hit.body) as { model?: string }).model ?? '';
}

function countShare(basisPoints: number): number {
  let canary = 0;
  for (let index = 0; index < 10_000; index += 1) {
    const cohort = assignCohort({
      tenantId: TENANT,
      alias: 'auto',
      policyVersionId: VERSION_A,
      routingKey: `k${index}`,
      basisPoints,
    });
    if (cohort === 'canary') canary += 1;
  }
  return canary;
}

describe('canary assignment', () => {
  it('pins 0, 1, 5, and 100 percent and changes with the policy version', () => {
    const atOne = countShare(100);
    const atFive = countShare(500);
    expect(Math.abs(atOne / 10_000 - 0.01)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(atFive / 10_000 - 0.05)).toBeLessThanOrEqual(0.005);
    expect(countShare(0)).toBe(0);
    expect(countShare(10_000)).toBe(10_000);
    const sample = {
      tenantId: TENANT,
      alias: 'auto',
      policyVersionId: VERSION_A,
      routingKey: 'conversation-stable',
      basisPoints: 5_000,
    };
    expect(assignCohort(sample)).toBe(assignCohort(sample));
    expect(assignCohort({ ...sample, basisPoints: 0 })).toBe('baseline');
    expect(assignCohort({ ...sample, basisPoints: 10_000 })).toBe('canary');
    let flipped = false;
    for (let index = 0; index < 200; index += 1) {
      const routingKey = `version-${index}`;
      const left = assignCohort({ ...sample, routingKey, basisPoints: 5_000 });
      const right = assignCohort({ ...sample, policyVersionId: VERSION_B, routingKey, basisPoints: 5_000 });
      if (left !== right) {
        flipped = true;
        expect(assignCohort({ ...sample, routingKey, basisPoints: 5_000 })).toBe(left);
        break;
      }
    }
    expect(flipped).toBe(true);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { assignCohort } from './dist/inference/canary-assignment.js';
process.stdout.write(assignCohort(${JSON.stringify(sample)}));`,
      ],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout).toBe(assignCohort(sample));
    console.log(`CANARY_DISTRIBUTION 100=${atOne} 500=${atFive}`);
    console.log(`CANARY_REPLICA ${child.stdout}`);
    const directory = join(projectRoot, 'evidence', 'slice-08d');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'assignment-fixtures.json'),
      `${JSON.stringify({
        version: 1,
        tenantId: TENANT,
        policyVersionId: VERSION_A,
        counts: { keys: 10_000, basisPoints100: atOne, basisPoints500: atFive, basisPoints0: 0, basisPoints10000: 10_000 },
        replica: { routingKey: 'conversation-stable', basisPoints: 5_000, cohort: child.stdout },
      }, null, 2)}\n`,
    );
  });
});

describe('controlled canary routing', () => {
  const db = loadTestDatabase();
  const scripts = new Map<string, Script>();
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: App;
  let admin: pg.Pool;
  let tenant: Tenant;
  let other: Tenant;
  let policyId = '';
  let snapshotId = '';
  let spareConfig = 1;
  let sequence = 0;
  let fallbackOn = false;

  function cli(args: string[]): Record<string, unknown> {
    return runCli(db, args, cliEnv()) as Record<string, unknown>;
  }

  function nextKey(name: string): string {
    sequence += 1;
    return `c${sequence}-${name}`;
  }

  function trace(name: string, fields: Record<string, unknown>): void {
    console.log(`CANARY_TRACE ${name} ${JSON.stringify(fields)}`);
  }

  async function stopActive(): Promise<void> {
    const rows = await admin.query<{ id: string; epoch: number }>(
      `SELECT id::text AS id, epoch
       FROM routing_rollouts
       WHERE tenant_id = $1 AND status = 'active'`,
      [tenant.tenantId],
    );
    const row = rows.rows[0];
    if (row === undefined) return;
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${row.id}/stop`,
      headers: auth(tenant, `stop-${row.id}`),
      payload: { expectedEpoch: Number(row.epoch) },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
  }

  function clearFallback(): void {
    if (!fallbackOn) return;
    cli([
      'set-fallback-policy',
      '--tenant-id', tenant.tenantId,
      '--alias', 'auto',
      '--enabled', 'false',
      '--deployments', 'alpha-chat',
      '--failures', 'unavailable',
      '--max-attempts', '2',
      '--capabilities', 'temperature',
      '--providers', 'openai',
      '--data-collection', 'allow',
      '--min-remaining-deadline-ms', '0',
    ]);
    fallbackOn = false;
  }

  function setFallback(options: { providers?: string; regions?: string; data?: string; failures?: string }): void {
    const args = [
      'set-fallback-policy',
      '--tenant-id', tenant.tenantId,
      '--alias', 'auto',
      '--enabled', 'true',
      '--deployments', 'alpha-chat',
      '--failures', options.failures ?? 'unavailable',
      '--max-attempts', '2',
      '--capabilities', 'temperature',
      '--providers', options.providers ?? 'openai',
      '--data-collection', options.data ?? 'allow',
      '--min-remaining-deadline-ms', '0',
    ];
    if (options.regions !== undefined) args.push('--regions', options.regions);
    cli(args);
    fallbackOn = true;
  }

  async function chat(
    caller: Tenant,
    model: string,
    content: string,
    extra: Record<string, unknown> = {},
    routingKey?: string,
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(caller, undefined, routingKey),
      payload: chatPayload(model, content, extra),
    });
  }

  async function assignment(requestId: string): Promise<{
    cohort: string;
    cohort_deployment: string;
    executed_deployment: string;
    hold_reason: string;
    routing_key_digest: string | null;
    policy_version_id: string | null;
    raw: string;
  } | null> {
    const result = await admin.query<{
      cohort: string;
      cohort_deployment: string;
      executed_deployment: string;
      hold_reason: string;
      routing_key_digest: string | null;
      policy_version_id: string | null;
      raw: string;
    }>(
      `SELECT a.cohort, cohort.name AS cohort_deployment, executed.name AS executed_deployment,
              a.hold_reason, a.routing_key_digest, a.policy_version_id::text AS policy_version_id,
              row_to_json(a)::text AS raw
       FROM routing_canary_assignments a
       JOIN model_deployments cohort ON cohort.tenant_id = a.tenant_id AND cohort.id = a.cohort_deployment_id
       JOIN model_deployments executed ON executed.tenant_id = a.tenant_id AND executed.id = a.executed_deployment_id
       WHERE a.request_id = $1`,
      [requestId],
    );
    return result.rows[0] ?? null;
  }

  async function rolloutStatus(id: string): Promise<{ status: string; stop_reason: string | null; epoch: number; canary_request_count: number; canary_expense: string }> {
    const result = await admin.query<{ status: string; stop_reason: string | null; epoch: number; canary_request_count: number; canary_expense: string }>(
      `SELECT status, stop_reason, epoch, canary_request_count, canary_expense::text AS canary_expense
       FROM routing_rollouts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('rollout was not stored');
    return row;
  }

  function body(basisPoints: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      policyId,
      basisPoints,
      maxRequestCount: 1_000,
      maxExpense: '5',
      maxDurationSeconds: 86_400,
      evidenceSnapshotId: snapshotId,
      criticalErrorThreshold: 100,
      ...overrides,
    };
  }

  async function activate(basisPoints: number, overrides: Record<string, unknown> = {}): Promise<{ id: string; epoch: number; versionId: string; basisPoints: number }> {
    await stopActive();
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('activate')),
      payload: body(basisPoints, overrides),
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { id: string; epoch: number; versionId: string; basisPoints: number };
  }

  async function insertSnapshot(input: {
    versionId: string;
    name: string;
    status: 'qualified' | 'unqualified' | 'invalidated';
    stale: boolean;
  }): Promise<string> {
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO evidence_snapshots (
         tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
         idempotency_key, request_hash, created_at
       ) VALUES (
         $1, $2, '{}'::uuid[], 1, 20, $3, $4,
         CASE WHEN $5::boolean THEN statement_timestamp() - interval '2 hours' ELSE statement_timestamp() END
       ) RETURNING id::text AS id`,
      [tenant.tenantId, input.versionId, nextKey(input.name), HASH, input.stale],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('snapshot was not stored');
    if (input.status === 'qualified') {
      await admin.query(
        `INSERT INTO evidence_candidate_assessments (
           tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
           challenger_passes, challenger_trials, original_passes, original_trials
         ) VALUES ($1, $2, 'qualified', '{}', 0.9, 1, 0, 20, 20, 20, 20)`,
        [tenant.tenantId, id],
      );
    } else {
      await admin.query(
        `INSERT INTO evidence_candidate_assessments (
           tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
           challenger_passes, challenger_trials, original_passes, original_trials
         ) VALUES ($1, $2, $3, ARRAY['insufficient_samples'], 0.1, 0.2, -0.5, 1, 20, 20, 20)`,
        [tenant.tenantId, id, input.status],
      );
    }
    return id;
  }

  async function qualify(name: string, freshnessSeconds: number): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/qualification-profiles',
      headers: auth(tenant, nextKey(name)),
      payload: {
        name,
        taskCategory: 'general_qa',
        complexity: 'low',
        inputSizeCategory: 'xs',
        outputRequirementId: outputRequirementId,
        requiredCapabilities: ['temperature'],
        candidateDeployment: 'alpha-spare',
        modelVersion: 'gpt-canary-spare',
        deploymentConfigVersion: spareConfig,
        adapterVersion: 1,
        minSamples: 1,
        objectiveFloor: '0.80000',
        maxIntervalWidth: '0.20000',
        noninferiorityMargin: '0.05000',
        freshnessSeconds,
        minCoverage: '1.00000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { versionId: string }).versionId;
  }

  let outputRequirementId = '';

  beforeAll(async () => {
    mock = await startMockUpstream((_hit, _request, response) => {
      const parsed = JSON.parse(_hit.body) as { model?: string; stream?: boolean };
      const model = parsed.model ?? '';
      const script = scripts.get(model) ?? 'ok';
      if (script === 'partial') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(PARTIAL);
        return;
      }
      if (script === '500' || script === '503') {
        response.writeHead(script === '500' ? 500 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      if (parsed.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseBody(model));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1_700_000_000,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: `from-${model}` }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }));
    });
    tenant = provisionTenant(db, 'Canary A');
    other = provisionTenant(db, 'Canary B');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-canary-a',
      deployment: 'alpha-chat',
      upstreamModel: 'gpt-canary-base',
    });
    cli([
      'register-deployment', '--tenant-id', tenant.tenantId, '--name', 'alpha-spare',
      '--upstream-model', 'gpt-canary-spare', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-canary-b',
      deployment: 'beta-chat',
      upstreamModel: 'gpt-tenant-b',
    });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'alpha-chat' });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'alpha-spare' });
    for (const name of ['alpha-chat', 'alpha-spare']) {
      cli(['set-deployment-data-collection', '--tenant-id', tenant.tenantId, '--deployment', name, '--data-collection', 'allow']);
      cli(['set-deployment-context-limit', '--tenant-id', tenant.tenantId, '--deployment', name, '--context-limit', '128']);
    }
    cli([
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'alpha-spare',
      '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
      '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    cli([
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-canary-spare',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.01',
    ]);
    admin = adminPool(db);
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = ANY($2::text[])`,
      [tenant.tenantId, ['alpha-chat', 'alpha-spare']],
    );
    const config = await admin.query<{ config_version: number }>(
      `SELECT config_version FROM model_deployments WHERE tenant_id = $1 AND name = 'alpha-spare'`,
      [tenant.tenantId],
    );
    spareConfig = Number(config.rows[0]?.config_version ?? 0);
    expect(spareConfig).toBeGreaterThan(0);
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
        name: 'canary-extract',
        taskCategory: 'extraction',
        config: {
          limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 },
          validators: [{ id: 'json_parse', version: 1 }],
        },
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
    const versionId = await qualify('qp-canary-main', 86_400);
    snapshotId = await insertSnapshot({ versionId, name: 'main', status: 'qualified', stale: false });
    const policy = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(tenant, nextKey('policy')),
      payload: {
        name: 'auto-shadow',
        alias: 'auto',
        baselineDeployment: 'alpha-chat',
        candidateDeployments: ['alpha-chat', 'alpha-spare'],
        qualityMinPassRate: '0.90000',
        qualityMinValidPairs: 20,
        maxCostPerRequest: '0.05000000',
        maxLatencyMs: 4000,
        taskSegments: ['general_qa'],
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
    const migrations = await admin.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version IN ('028_shadow_ranking.sql', '029_routing_rollouts.sql') ORDER BY version`,
    );
    expect(migrations.rows.map((row) => row.version)).toEqual(['028_shadow_ranking.sql', '029_routing_rollouts.sql']);
  });

  afterEach(async () => {
    scripts.clear();
    clearFallback();
    await stopActive();
  });

  afterAll(async () => {
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await mock.close();
  });

  it('requires a shadow policy and qualified evidence before activation', async () => {
    const missing = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('omit')),
      payload: { policyId, maxRequestCount: 10, maxExpense: '1', maxDurationSeconds: 60, evidenceSnapshotId: snapshotId, criticalErrorThreshold: 1 },
    });
    expect(missing.statusCode).toBe(400);
    const extra = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('extra')),
      payload: { ...body(10_000), note: 'no' },
    });
    expect(extra.statusCode).toBe(400);
    const draft = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(tenant, nextKey('draft')),
      payload: {
        name: 'auto-draft',
        alias: 'auto',
        baselineDeployment: 'alpha-chat',
        candidateDeployments: ['alpha-spare'],
        qualityMinPassRate: '0.90000',
        qualityMinValidPairs: 20,
        maxCostPerRequest: '0.05000000',
        maxLatencyMs: 4000,
        taskSegments: ['general_qa'],
      },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const draftId = (draft.json() as { id: string }).id;
    const tooEarly = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('early')),
      payload: { ...body(100), policyId: draftId },
    });
    expect(tooEarly.statusCode).toBe(409);
    expect(tooEarly.json().error.code).toBe('policy_not_shadow');
    const poorVersion = await qualify('qp-canary-poor', 86_400);
    const poor = await insertSnapshot({ versionId: poorVersion, name: 'poor', status: 'unqualified', stale: false });
    const unqualified = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('poor')),
      payload: { ...body(100), evidenceSnapshotId: poor },
    });
    expect(unqualified.statusCode).toBe(409);
    expect(unqualified.json().error.code).toBe('evidence_not_qualified');
    const oldVersion = await qualify('qp-canary-old', 1);
    const old = await insertSnapshot({ versionId: oldVersion, name: 'old', status: 'qualified', stale: true });
    const stale = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('old')),
      payload: { ...body(100), evidenceSnapshotId: old },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('evidence_stale');
    const unknown = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('missing-snap')),
      payload: { ...body(100), evidenceSnapshotId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    });
    expect(unknown.statusCode).toBe(404);
    const reader = cli(['add-key', '--tenant-id', tenant.tenantId, '--label', 'canary-read']) as { keyId: string; secret: string };
    const writer = cli(['add-key', '--tenant-id', tenant.tenantId, '--label', 'canary-admin']) as { keyId: string; secret: string };
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [tenant.tenantId, reader.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [tenant.tenantId, writer.keyId]);
    const readTenant = { ...tenant, secret: reader.secret, keyId: reader.keyId };
    const adminTenant = { ...tenant, secret: writer.secret, keyId: writer.keyId };
    const deniedWrite = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(readTenant, nextKey('read-write')),
      payload: body(10_000),
    });
    expect(deniedWrite.statusCode).toBe(403);
    expect(deniedWrite.json().error.message).toBe('The credential cannot use this route.');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, 'canary-create-once'),
      payload: body(10_000),
    });
    expect(created.statusCode, created.body).toBe(201);
    const rollout = created.json() as {
      id: string;
      epoch: number;
      basisPoints: number;
      status: string;
      baselineDeployment: string;
      challengerDeployment: string;
      maxExpense: string;
      versionId: string;
    };
    expect(rollout.basisPoints).toBe(10_000);
    expect(rollout.epoch).toBe(1);
    expect(rollout.status).toBe('active');
    expect(rollout.baselineDeployment).toBe('alpha-chat');
    expect(rollout.challengerDeployment).toBe('alpha-spare');
    expect(rollout.maxExpense).toBe('5.00000000');
    const replay = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, 'canary-create-once'),
      payload: body(10_000),
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(rollout.id);
    const clash = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, 'canary-create-once'),
      payload: body(100),
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('idempotency_conflict');
    const second = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(tenant, nextKey('second')),
      payload: body(100),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('activation_conflict');
    const hidden = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/rollouts/${rollout.id}`,
      headers: auth(adminTenant),
    });
    expect(hidden.statusCode).toBe(403);
    const read = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/rollouts/${rollout.id}`,
      headers: auth(tenant),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().versionId).toBe(rollout.versionId);
    const foreign = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/rollouts/${rollout.id}`,
      headers: auth(other),
    });
    expect(foreign.statusCode).toBe(404);
    const staleStop = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
      headers: auth(tenant, nextKey('stale-stop')),
      payload: { expectedEpoch: 2 },
    });
    expect(staleStop.statusCode).toBe(409);
    expect(staleStop.json().error.code).toBe('stale_activation');
    const foreignStop = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
      headers: auth(other, nextKey('foreign-stop')),
      payload: { expectedEpoch: 1 },
    });
    expect(foreignStop.statusCode).toBe(404);
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
      headers: auth(tenant, 'canary-stop-once'),
      payload: { expectedEpoch: 1 },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.json().status).toBe('stopped');
    expect(stopped.json().stopReason).toBe('manual');
    const stopReplay = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
      headers: auth(tenant, 'canary-stop-once'),
      payload: { expectedEpoch: 1 },
    });
    expect(stopReplay.statusCode).toBe(200);
    expect(stopReplay.json().id).toBe(rollout.id);
  });

  it('assigns the keyed share and leaves a forced model and the other tenant alone', async () => {
    const zero = await activate(0);
    const zeroChat = await chat(tenant, 'auto', 'share-zero-prompt');
    expect(zeroChat.statusCode, zeroChat.body).toBe(200);
    expect(zeroChat.json().model).toBe('gpt-canary-base');
    const zeroRow = await assignment(String(zeroChat.headers['x-request-id']));
    expect(zeroRow?.cohort).toBe('baseline');
    expect(zeroRow?.hold_reason).toBe('share_baseline');
    expect(zeroRow?.raw).not.toContain('share-zero-prompt');
    const full = await activate(10_000);
    expect(full.basisPoints).toBe(10_000);
    const first = await chat(tenant, 'auto', 'prompt-alpha', {}, 'conversation-1');
    const second = await chat(tenant, 'auto', 'prompt-beta-different', {}, 'conversation-1');
    expect(first.statusCode, first.body).toBe(200);
    expect(second.json().model).toBe('gpt-canary-spare');
    const firstRow = await assignment(String(first.headers['x-request-id']));
    const secondRow = await assignment(String(second.headers['x-request-id']));
    expect(firstRow?.cohort).toBe('canary');
    expect(firstRow?.routing_key_digest).toBe(routingKeyDigest('conversation-1'));
    expect(firstRow?.routing_key_digest).not.toBe('conversation-1');
    expect(secondRow?.routing_key_digest).toBe(firstRow?.routing_key_digest);
    expect(firstRow?.raw).not.toContain('conversation-1');
    expect(firstRow?.raw).not.toContain('prompt-alpha');
    expect(firstRow?.policy_version_id).toBe(full.versionId);
    const openA = await chat(tenant, 'auto', 'prompt-gamma');
    const openB = await chat(tenant, 'auto', 'prompt-delta');
    const openRowA = await assignment(String(openA.headers['x-request-id']));
    const openRowB = await assignment(String(openB.headers['x-request-id']));
    expect(openRowA?.cohort).toBe('canary');
    expect(openRowB?.cohort).toBe('canary');
    expect(openRowA?.routing_key_digest).not.toBe(openRowB?.routing_key_digest);
    const narrow = await activate(100);
    let canaryKey = '';
    let baselineKey = '';
    for (let index = 0; index < 5_000; index += 1) {
      const routingKey = `share-100-${index}`;
      const cohort = assignCohort({
        tenantId: tenant.tenantId,
        alias: 'auto',
        policyVersionId: narrow.versionId,
        routingKey,
        basisPoints: 100,
      });
      if (cohort === 'canary' && canaryKey === '') canaryKey = routingKey;
      if (cohort === 'baseline' && baselineKey === '') baselineKey = routingKey;
      if (canaryKey !== '' && baselineKey !== '') break;
    }
    expect(canaryKey).not.toBe('');
    expect(baselineKey).not.toBe('');
    const canaryChat = await chat(tenant, 'auto', 'one-percent-canary', {}, canaryKey);
    const baselineChat = await chat(tenant, 'auto', 'one-percent-baseline', {}, baselineKey);
    expect((await assignment(String(canaryChat.headers['x-request-id'])))?.cohort).toBe('canary');
    expect(canaryChat.json().model).toBe('gpt-canary-spare');
    expect((await assignment(String(baselineChat.headers['x-request-id'])))?.cohort).toBe('baseline');
    expect(baselineChat.json().model).toBe('gpt-canary-base');
    const five = await activate(500);
    let fiveCanary = '';
    let fiveBase = '';
    for (let index = 0; index < 5_000; index += 1) {
      const routingKey = `share-500-${index}`;
      const cohort = assignCohort({
        tenantId: tenant.tenantId,
        alias: 'auto',
        policyVersionId: five.versionId,
        routingKey,
        basisPoints: 500,
      });
      if (cohort === 'canary' && fiveCanary === '') fiveCanary = routingKey;
      if (cohort === 'baseline' && fiveBase === '') fiveBase = routingKey;
      if (fiveCanary !== '' && fiveBase !== '') break;
    }
    const fiveChat = await chat(tenant, 'auto', 'five-percent', {}, fiveCanary);
    const fiveStay = await chat(tenant, 'auto', 'five-percent-base', {}, fiveBase);
    expect(fiveChat.json().model).toBe('gpt-canary-spare');
    expect(fiveStay.json().model).toBe('gpt-canary-base');
    let changed = false;
    for (let index = 0; index < 200; index += 1) {
      const routingKey = `live-version-${index}`;
      const current = assignCohort({
        tenantId: tenant.tenantId,
        alias: 'auto',
        policyVersionId: five.versionId,
        routingKey,
        basisPoints: 5_000,
      });
      const next = assignCohort({
        tenantId: tenant.tenantId,
        alias: 'auto',
        policyVersionId: VERSION_B,
        routingKey,
        basisPoints: 5_000,
      });
      if (current !== next) {
        changed = true;
        break;
      }
    }
    expect(changed).toBe(true);
    const forced = await activate(10_000);
    const named = await chat(tenant, 'alpha-chat', 'forced-baseline');
    expect(named.json().model).toBe('gpt-canary-base');
    expect(named.headers['x-deployment']).toBe('alpha-chat');
    expect(await assignment(String(named.headers['x-request-id']))).toBeNull();
    const namedSpare = await chat(tenant, 'alpha-spare', 'forced-spare');
    expect(namedSpare.json().model).toBe('gpt-canary-spare');
    expect(await assignment(String(namedSpare.headers['x-request-id']))).toBeNull();
    const neighbor = await chat(other, 'auto', 'tenant-b-stays');
    expect(neighbor.statusCode, neighbor.body).toBe(200);
    expect(neighbor.json().model).toBe('gpt-tenant-b');
    expect(await assignment(String(neighbor.headers['x-request-id']))).toBeNull();
    const peek = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/rollouts/${forced.id}`,
      headers: auth(other),
    });
    expect(peek.statusCode).toBe(404);
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${forced.id}/stop`,
      headers: auth(other, nextKey('b-stop')),
      payload: { expectedEpoch: forced.epoch },
    });
    expect(blocked.statusCode).toBe(404);
    const still = await chat(tenant, 'auto', 'tenant-a-still');
    expect(still.json().model).toBe('gpt-canary-spare');
    trace('share', { zero: 'baseline', full: 'canary', forced: 'bypass', tenantB: neighbor.json().model });
    const badKey = await chat(tenant, 'auto', 'bad-key', {}, 'has space');
    expect(badKey.statusCode).toBe(400);
    expect(mock.hits.filter((hit) => hit.body.includes('bad-key'))).toHaveLength(0);
  });

  it('holds the baseline when the challenger fails a gate and does not stop the rollout', async () => {
    const rollout = await activate(10_000);
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'unvalidated' WHERE tenant_id = $1 AND name = 'alpha-spare'`,
      [tenant.tenantId],
    );
    try {
      const response = await chat(tenant, 'auto', 'unvalidated-challenger');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-canary-base');
      const row = await assignment(String(response.headers['x-request-id']));
      expect(row?.hold_reason).toBe('deployment_unvalidated');
      expect(row?.cohort).toBe('baseline');
      expect((await rolloutStatus(rollout.id)).status).toBe('active');
    } finally {
      await admin.query(
        `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = 'alpha-spare'`,
        [tenant.tenantId],
      );
    }
    await admin.query(
      `UPDATE model_deployments SET enabled = false WHERE tenant_id = $1 AND name = 'alpha-spare'`,
      [tenant.tenantId],
    );
    try {
      const response = await chat(tenant, 'auto', 'disabled-challenger');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-canary-base');
      expect((await assignment(String(response.headers['x-request-id'])))?.hold_reason).toBe('deployment_unvalidated');
      expect((await rolloutStatus(rollout.id)).status).toBe('active');
    } finally {
      await admin.query(
        `UPDATE model_deployments SET enabled = true WHERE tenant_id = $1 AND name = 'alpha-spare'`,
        [tenant.tenantId],
      );
    }
    setFallback({ providers: 'anthropic' });
    const provider = await chat(tenant, 'auto', 'provider-hold');
    expect(provider.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(provider.headers['x-request-id'])))?.hold_reason).toBe('provider_permission');
    clearFallback();
    setFallback({ regions: 'us-central1' });
    const region = await chat(tenant, 'auto', 'region-hold');
    expect(region.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(region.headers['x-request-id'])))?.hold_reason).toBe('region_policy');
    clearFallback();
    setFallback({ data: 'deny' });
    const data = await chat(tenant, 'auto', 'data-hold');
    expect(data.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(data.headers['x-request-id'])))?.hold_reason).toBe('data_policy');
    expect((await rolloutStatus(rollout.id)).status).toBe('active');
    trace('gates', { unvalidated: 'baseline', disabled: 'baseline', provider: 'baseline', region: 'baseline', data: 'baseline' });
  });

  it('stops on invalidated evidence, the request cap, and the expense cap', async () => {
    const capped = await activate(10_000, { maxRequestCount: 1 });
    const first = await chat(tenant, 'auto', 'request-cap-one');
    expect(first.json().model).toBe('gpt-canary-spare');
    const second = await chat(tenant, 'auto', 'request-cap-two');
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(second.headers['x-request-id'])))?.hold_reason).toBe('request_cap');
    expect((await rolloutStatus(capped.id)).stop_reason).toBe('request_cap');
    const expensive = await activate(10_000, { maxExpense: '0.00000001' });
    const spent = await chat(tenant, 'auto', 'expense-cap');
    expect(spent.statusCode, spent.body).toBe(200);
    expect(spent.json().model).toBe('gpt-canary-spare');
    const spentRow = await rolloutStatus(expensive.id);
    expect(spentRow.stop_reason).toBe('expense_cap');
    expect(Number(spentRow.canary_expense)).toBeGreaterThan(0);
    const afterSpend = await chat(tenant, 'auto', 'expense-after');
    expect(afterSpend.json().model).toBe('gpt-canary-base');
    const rollout = await activate(10_000);
    const version = await admin.query<{ profile_version_id: string }>(
      `SELECT profile_version_id::text AS profile_version_id FROM evidence_snapshots WHERE id = $1`,
      [snapshotId],
    );
    const profileVersionId = version.rows[0]?.profile_version_id;
    if (profileVersionId === undefined) throw new Error('profile version was not stored');
    await insertSnapshot({ versionId: profileVersionId, name: 'invalidated', status: 'invalidated', stale: false });
    const held = await chat(tenant, 'auto', 'invalidated-evidence');
    expect(held.statusCode, held.body).toBe(200);
    expect(held.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(held.headers['x-request-id'])))?.hold_reason).toBe('evidence_invalid');
    expect((await rolloutStatus(rollout.id)).stop_reason).toBe('evidence_invalid');
    const replacement = await qualify('qp-canary-replacement', 86_400);
    snapshotId = await insertSnapshot({ versionId: replacement, name: 'replacement', status: 'qualified', stale: false });
    trace('caps', { invalidated: 'baseline', requestCap: 'baseline', expense: spentRow.canary_expense });
  });

  it('stops when the duration elapses or the evidence becomes stale', async () => {
    const brief = await activate(10_000, { maxDurationSeconds: 1 });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const expired = await chat(tenant, 'auto', 'duration-limit');
    expect(expired.statusCode, expired.body).toBe(200);
    expect(expired.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(expired.headers['x-request-id'])))?.hold_reason).toBe('duration_limit');
    expect((await rolloutStatus(brief.id)).stop_reason).toBe('duration_limit');
    const freshVersion = await qualify('qp-canary-fresh', 1);
    const fresh = await insertSnapshot({ versionId: freshVersion, name: 'fresh', status: 'qualified', stale: false });
    const aging = await activate(10_000, { evidenceSnapshotId: fresh, maxDurationSeconds: 86_400 });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const aged = await chat(tenant, 'auto', 'evidence-aged');
    expect(aged.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(aged.headers['x-request-id'])))?.hold_reason).toBe('evidence_stale');
    expect((await rolloutStatus(aging.id)).stop_reason).toBe('evidence_stale');
  });

  it('keeps breaker, budget, and rate-limit denials on the pinned deployment', async () => {
    const rollout = await activate(10_000);
    cli([
      'set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', 'alpha-spare',
      '--enabled', 'true', '--window-ms', '60000', '--min-samples', '2', '--failure-threshold', '1',
      '--cooldown-ms', '60000', '--max-probes', '1',
    ]);
    await admin.query(
      `UPDATE deployment_breakers
       SET state = 'open', state_reason = 'failure_threshold', cooldown_until = statement_timestamp() + interval '1 hour'
       WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'alpha-spare')`,
      [tenant.tenantId],
    );
    try {
      const blocked = await chat(tenant, 'auto', 'breaker-open');
      expect(blocked.statusCode).toBe(503);
      expect(blocked.json().error.code).toBe('circuit_open');
      expect(mock.hits.filter((hit) => hit.body.includes('breaker-open'))).toHaveLength(0);
      expect((await assignment(String(blocked.headers['x-request-id'])))?.cohort).toBe('canary');
      expect((await rolloutStatus(rollout.id)).status).toBe('active');
    } finally {
      await admin.query(
        `UPDATE deployment_breakers
         SET state = 'closed', state_reason = 'reset', cooldown_until = statement_timestamp() - interval '1 hour'
         WHERE deployment_id = (SELECT id FROM model_deployments WHERE tenant_id = $1 AND name = 'alpha-spare')`,
        [tenant.tenantId],
      );
    }
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '0.01']);
    try {
      const denied = await chat(tenant, 'auto', 'budget-canary-deny');
      expect(denied.statusCode).toBe(429);
      expect(denied.json().error.code).toBe('budget_exceeded');
      expect((await assignment(String(denied.headers['x-request-id'])))?.cohort).toBe('canary');
      expect(mock.hits.filter((hit) => hit.body.includes('budget-canary-deny'))).toHaveLength(0);
    } finally {
      cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'disabled', '--monthly-amount', '0']);
    }
    cli([
      'set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--requests-per-minute', '1',
      '--concurrent-requests', '10', '--concurrent-streams', '10', '--token-rate', '100000', '--lease-ms', '1000',
    ]);
    try {
      const allowed = await chat(tenant, 'auto', 'rate-first');
      expect(allowed.statusCode, allowed.body).toBe(200);
      expect(allowed.json().model).toBe('gpt-canary-spare');
      const limited = await chat(tenant, 'auto', 'rate-second');
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.code).toBe('tenant_rate_limited');
      expect((await assignment(String(limited.headers['x-request-id'])))?.cohort).toBe('canary');
    } finally {
      cli(['set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', 'observe', '--requests-per-minute', '100000']);
    }
    cli(['set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', 'alpha-spare', '--enabled', 'false']);
    trace('denials', { breaker: 'circuit_open', budget: 'budget_exceeded', rate: 'tenant_rate_limited' });
  });

  it('streams the canary, keeps a partial body on that model, and falls back before the first byte', async () => {
    const rollout = await activate(10_000);
    const streamed = await chat(tenant, 'auto', 'stream-ok', { stream: true });
    expect(streamed.statusCode, streamed.body).toBe(200);
    expect(streamed.body).toContain('gpt-canary-spare');
    expect(streamed.body).toContain('data: [DONE]');
    expect(streamed.headers['x-deployment']).toBe('alpha-spare');
    const streamedRow = await assignment(String(streamed.headers['x-request-id']));
    expect(streamedRow?.cohort).toBe('canary');
    expect(streamedRow?.executed_deployment).toBe('alpha-spare');
    setFallback({ failures: 'unavailable,upstream_error,stream_started' });
    scripts.set('gpt-canary-spare', 'partial');
    const partial = await chat(tenant, 'auto', 'stream-partial', { stream: true });
    expect(partial.body).toContain('partial-canary');
    expect(partial.body).not.toContain('data: [DONE]');
    expect(partial.body).not.toContain('gpt-canary-base');
    expect(mock.hits.filter((hit) => hit.body.includes('stream-partial')).map(modelOf)).toEqual(['gpt-canary-spare']);
    const partialRow = await assignment(String(partial.headers['x-request-id']));
    expect(partialRow?.cohort).toBe('canary');
    expect(partialRow?.executed_deployment).toBe('alpha-spare');
    const partialAttempt = await admin.query<{ failure_class: string | null }>(
      `SELECT failure_class FROM model_attempts
       WHERE request_id = $1
       ORDER BY attempt_ordinal DESC LIMIT 1`,
      [String(partial.headers['x-request-id'])],
    );
    expect(partialAttempt.rows[0]?.failure_class).toBe('stream_started');
    scripts.set('gpt-canary-spare', '503');
    const fell = await chat(tenant, 'auto', 'fallback-ok');
    expect(fell.statusCode, fell.body).toBe(200);
    expect(fell.json().model).toBe('gpt-canary-base');
    expect(fell.headers['x-deployment']).toBe('alpha-chat');
    expect(fell.headers['x-fallback']).toBe('true');
    const fellRow = await assignment(String(fell.headers['x-request-id']));
    expect(fellRow?.cohort).toBe('canary');
    expect(fellRow?.cohort_deployment).toBe('alpha-spare');
    expect(fellRow?.executed_deployment).toBe('alpha-chat');
    expect((await rolloutStatus(rollout.id)).status).toBe('active');
    trace('stream', { success: 'alpha-spare', partial: 'alpha-spare', fallbackExecuted: 'alpha-chat', cohort: 'canary' });
  });

  it('stops manually, stays stopped in a new process, and keeps an active canary in a new process', async () => {
    const rollout = await activate(10_000);
    const replica = createPool(ctx.config, 'runtime', undefined, 1);
    try {
      const started = performance.now();
      const stopped = await ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/rollouts/${rollout.id}/stop`,
        headers: auth(tenant, nextKey('measured-stop')),
        payload: { expectedEpoch: rollout.epoch },
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      const seen = await withTenant(replica, tenant.tenantId, async (client) => {
        const row = await client.query<{ status: string }>(
          `SELECT status FROM routing_rollouts WHERE id = $1`,
          [rollout.id],
        );
        return row.rows[0]?.status ?? '';
      });
      const elapsed = Math.ceil(performance.now() - started);
      console.log(`CANARY_STOP_VISIBILITY_MS ${elapsed}`);
      expect(seen).toBe('stopped');
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      await replica.end();
    }
    const restarted = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    try {
      const response = await restarted.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: auth(tenant),
        payload: chatPayload('auto', 'after-restart-stopped'),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-canary-base');
    } finally {
      await restarted.app.close();
      await restarted.authPool.end();
      await restarted.runtimePool.end();
    }
    await activate(10_000);
    const resumed = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    try {
      const response = await resumed.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: auth(tenant),
        payload: chatPayload('auto', 'after-restart-active'),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-canary-spare');
    } finally {
      await resumed.app.close();
      await resumed.authPool.end();
      await resumed.runtimePool.end();
    }
    console.log('CANARY_ROLLBACK stop returns auto to the alias baseline');
  });

  it('uses the baseline when the rollout table cannot be read', async () => {
    await activate(10_000);
    await admin.query('REVOKE SELECT ON routing_rollouts FROM llm_runtime');
    try {
      const response = await chat(tenant, 'auto', 'safety-unreadable');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-canary-base');
      const row = await assignment(String(response.headers['x-request-id']));
      expect(row?.cohort).toBe('baseline');
      expect(row?.hold_reason).toBe('safety_unreadable');
    } finally {
      await admin.query('GRANT SELECT ON routing_rollouts TO llm_runtime');
    }
  });

  it('stops when a canary attempt hits the critical error threshold', async () => {
    const rollout = await activate(10_000, { criticalErrorThreshold: 1 });
    scripts.set('gpt-canary-spare', '500');
    const failed = await chat(tenant, 'auto', 'critical-stop');
    expect(failed.statusCode, failed.body).toBe(502);
    expect(failed.json().error.code).toBe('upstream_error');
    expect((await rolloutStatus(rollout.id)).stop_reason).toBe('critical_errors');
    scripts.set('gpt-canary-spare', 'ok');
    const next = await chat(tenant, 'auto', 'critical-after');
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().model).toBe('gpt-canary-base');
  });

  it('stops new canary traffic when the shadow policy is disabled', async () => {
    const rollout = await activate(10_000);
    const current = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies/${policyId}`,
      headers: auth(tenant),
    });
    expect(current.statusCode, current.body).toBe(200);
    const disabled = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${policyId}/status`,
      headers: auth(tenant, nextKey('disable-policy')),
      payload: { status: 'disabled', expectedEpoch: current.json().epoch },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    const response = await chat(tenant, 'auto', 'policy-disabled');
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().model).toBe('gpt-canary-base');
    expect((await assignment(String(response.headers['x-request-id'])))?.hold_reason).toBe('policy_disabled');
    expect((await rolloutStatus(rollout.id)).stop_reason).toBe('policy_disabled');
  });
});
