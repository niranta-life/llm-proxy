import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { assignCohort } from '../src/inference/canary-assignment.js';
import { wilsonInterval } from '../src/inference/evaluation-report.js';
import {
  decideGuardrails,
  emptyCohort,
  type CohortTotals,
  type GuardrailRule,
} from '../src/inference/guardrail-decision.js';
import { runGuardrailPass, type GuardrailPassReport } from '../src/inference/guardrail-worker.js';
import { createTestApp, loadTestDatabase, projectRoot, runCli, serviceEnv, type TestDatabase } from './helpers.js';
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

const HASH = 'cd'.repeat(32);
const EFFECTIVE = '2025-12-01T00:00:00.000Z';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-08e');

type Script = 'ok' | '500' | '503' | 'partial' | 'slow' | 'hold' | 'hold503';
type Tenant = ReturnType<typeof provisionTenant>;
type App = Awaited<ReturnType<typeof createTestApp>>;
type HoldGate = { ready: () => void; release: () => void; seen: Promise<void>; opened: Promise<void> };

function auth(tenant: Tenant, idempotencyKey?: string, routingKey?: string): Record<string, string> {
  return {
    'x-tenant-id': tenant.tenantId,
    authorization: `Bearer ${tenant.secret}`,
    'content-type': 'application/json',
    ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
    ...(routingKey === undefined ? {} : { 'x-llm-routing-key': routingKey }),
  };
}

function okBody(model: string): string {
  return JSON.stringify({
    id: 'chatcmpl-guard',
    object: 'chat.completion',
    created: 1_700_000_000,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: `from-${model}` }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  });
}

function sseHead(model: string): string {
  const head = { id: 'chatcmpl-guard', object: 'chat.completion.chunk', created: 1_700_000_000, model };
  return `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: { role: 'assistant', content: 'held' }, finish_reason: null }] })}\n\n`;
}

function sseRest(model: string): string {
  const head = { id: 'chatcmpl-guard', object: 'chat.completion.chunk', created: 1_700_000_000, model };
  return [
    `data: ${JSON.stringify({ ...head, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
}

function modelOf(hit: MockHit): string {
  return (JSON.parse(hit.body) as { model?: string }).model ?? '';
}

function cohort(name: 'baseline' | 'canary', patch: Partial<CohortTotals> = {}): CohortTotals {
  return { ...emptyCohort(name), ...patch };
}

function pureRule(patch: Partial<GuardrailRule> & Pick<GuardrailRule, 'kind' | 'signal'>): GuardrailRule {
  return {
    id: 'rule-pure',
    threshold: 0.5,
    margin: 0.05,
    minSamples: 30,
    windowSeconds: 3_600,
    maturitySeconds: 300,
    maxMissingFraction: 0.2,
    ...patch,
  };
}

describe('guardrail decision', () => {
  it('stops on a separated relative failure and holds when the intervals overlap', () => {
    const separated = decideGuardrails(
      [pureRule({ kind: 'relative_failure', signal: 'error_rate', minSamples: 30, margin: 0.05, threshold: 0.2 })],
      {
        capabilityViolations: 0,
        cohorts: [
          cohort('canary', { executions: 100, errorRequests: 90 }),
          cohort('baseline', { executions: 100, errorRequests: 5 }),
        ],
      },
    );
    const overlap = decideGuardrails(
      [pureRule({ kind: 'relative_failure', signal: 'error_rate', minSamples: 30, margin: 0.05, threshold: 0.2 })],
      {
        capabilityViolations: 0,
        cohorts: [
          cohort('canary', { executions: 100, errorRequests: 20 }),
          cohort('baseline', { executions: 100, errorRequests: 25 }),
        ],
      },
    );
    const worse = decideGuardrails(
      [pureRule({ kind: 'quality_regression', signal: 'task_success', minSamples: 30, margin: 0.05, threshold: 0.2 })],
      {
        capabilityViolations: 0,
        cohorts: [
          cohort('canary', { taskSuccesses: 20, taskFailures: 80, taskMature: 100 }),
          cohort('baseline', { taskSuccesses: 95, taskFailures: 5, taskMature: 100 }),
        ],
      },
    );
    const similar = decideGuardrails(
      [pureRule({ kind: 'quality_regression', signal: 'task_success', minSamples: 30, margin: 0.05, threshold: 0.2 })],
      {
        capabilityViolations: 0,
        cohorts: [
          cohort('canary', { taskSuccesses: 90, taskFailures: 10, taskMature: 100 }),
          cohort('baseline', { taskSuccesses: 90, taskFailures: 10, taskMature: 100 }),
        ],
      },
    );
    const missing = decideGuardrails(
      [pureRule({ kind: 'deterministic_quality', signal: 'task_success', minSamples: 1, threshold: 0.1, maxMissingFraction: 0.2 })],
      {
        capabilityViolations: 0,
        cohorts: [cohort('canary', { providerSuccesses: 10, taskMissing: 10, executions: 10 })],
      },
    );
    const few = decideGuardrails(
      [pureRule({ kind: 'absolute_failure', signal: 'error_rate', minSamples: 30, threshold: 0.5 })],
      { capabilityViolations: 0, cohorts: [cohort('canary', { executions: 5, errorRequests: 5 })] },
    );
    const delayed = decideGuardrails(
      [pureRule({ kind: 'deterministic_quality', signal: 'correctness', minSamples: 1, threshold: 0.1, maturitySeconds: 3_600 })],
      { capabilityViolations: 0, cohorts: [cohort('canary', { correctnessFailures: 0, correctnessImmature: 4, correctnessMature: 0 })] },
    );
    expect(separated.action).toBe('stop');
    expect(overlap.action).toBe('hold');
    expect(overlap.reason).toBe('inconclusive');
    expect(worse.action).toBe('stop');
    expect(similar.action).toBe('hold');
    expect(missing.action).toBe('hold');
    expect(missing.reason).toBe('missing_feedback');
    expect(missing.detail.successes ?? 0).toBe(0);
    expect(few.action).toBe('hold');
    expect(few.reason).toBe('insufficient_samples');
    expect(delayed.action).toBe('hold');
    expect(delayed.reason).toBe('immature');
    const canaryErrors = wilsonInterval(90, 100);
    const baselineErrors = wilsonInterval(5, 100);
    const canaryQuality = wilsonInterval(20, 100);
    const baselineQuality = wilsonInterval(95, 100);
    const overlapErrors = wilsonInterval(20, 100);
    const overlapBaseline = wilsonInterval(25, 100);
    expect(canaryErrors).not.toBeNull();
    expect(baselineErrors).not.toBeNull();
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, 'statistical-fixtures.json'),
      `${JSON.stringify({
        method: 'wilson_95_newcombe',
        relativeFailure: {
          action: separated.action,
          canary: canaryErrors,
          baseline: baselineErrors,
          margin: 0.05,
        },
        relativeFailureOverlap: {
          action: overlap.action,
          reason: overlap.reason,
          canary: overlapErrors,
          baseline: overlapBaseline,
          margin: 0.05,
        },
        qualityRegression: {
          action: worse.action,
          canary: canaryQuality,
          baseline: baselineQuality,
          margin: 0.05,
        },
        qualityOverlap: { action: similar.action, reason: similar.reason },
        missingFeedback: { action: missing.action, reason: missing.reason, successes: missing.detail.successes ?? 0 },
        tooFewSamples: { action: few.action, reason: few.reason },
        delayedFeedback: { action: delayed.action, reason: delayed.reason },
      }, null, 2)}\n`,
    );
  });

  it('does not stop a synthetic run that stays inside the gates', () => {
    const rule = pureRule({ kind: 'absolute_failure', signal: 'error_rate', threshold: 0.5, minSamples: 30 });
    let stops = 0;
    for (let index = 0; index < 200; index += 1) {
      const decision = decideGuardrails([rule], {
        capabilityViolations: 0,
        cohorts: [
          cohort('canary', { executions: 100, errorRequests: 2 }),
          cohort('baseline', { executions: 100, errorRequests: 2 }),
        ],
      });
      if (decision.action === 'stop') stops += 1;
    }
    console.log(`GUARDRAIL_FALSE_ROLLBACK ${stops}`);
    expect(stops).toBe(0);
  });

  it('keeps the proxy process and the image command free of the worker', () => {
    const indexSource = readFileSync(join(projectRoot, 'src/index.ts'), 'utf8');
    const docker = readFileSync(join(projectRoot, 'Dockerfile'), 'utf8');
    const worker = readFileSync(join(projectRoot, 'src/guardrail-worker.ts'), 'utf8');
    const pass = readFileSync(join(projectRoot, 'src/inference/guardrail-worker.ts'), 'utf8');
    expect(indexSource.includes('guardrail-worker')).toBe(false);
    expect(docker).toContain('CMD ["node", "dist/index.js"]');
    expect(docker.includes('guardrail-worker')).toBe(false);
    expect(worker.includes('Bearer')).toBe(false);
    expect(worker.toLowerCase().includes('authorization')).toBe(false);
    expect(pass.includes('Bearer')).toBe(false);
    expect(pass.toLowerCase().includes('authorization')).toBe(false);
    const db = loadTestDatabase();
    const child = spawnSync(process.execPath, ['dist/guardrail-worker.js'], {
      cwd: projectRoot,
      env: { ...serviceEnv(db), GUARDRAIL_ONCE: 'true', GUARDRAIL_TENANTS: '' },
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
    expect(`${child.stdout}\n${child.stderr}`).not.toMatch(/Bearer|sk-[A-Za-z0-9_-]+/);
  });
});

describe('routing guardrails', () => {
  const db = loadTestDatabase();
  const scripts = new Map<string, Script>();
  let hold: HoldGate | null = null;
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: App;
  let admin: pg.Pool;
  let tenant: Tenant;
  let other: Tenant;
  let reader: Tenant;
  let writer: Tenant;
  let plain: Tenant;
  let policyId = '';
  let snapshotId = '';
  let spareConfig = 1;
  let sequence = 0;
  let fallbackOn = false;
  let outputRequirementId = '';
  const cases: Record<string, unknown> = {};

  function cli(target: TestDatabase, args: string[]): Record<string, unknown> {
    return runCli(target, args, cliEnv()) as Record<string, unknown>;
  }

  function nextKey(name: string): string {
    sequence += 1;
    return `g${sequence}-${name}`;
  }

  function armHold(): HoldGate {
    let ready: () => void = () => undefined;
    let release: () => void = () => undefined;
    const seen = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    hold = { ready, release, seen, opened };
    return hold;
  }

  async function stopActive(caller: Tenant = tenant): Promise<void> {
    const rows = await admin.query<{ id: string; epoch: number }>(
      `SELECT id::text AS id, epoch FROM routing_rollouts WHERE tenant_id = $1 AND status = 'active'`,
      [caller.tenantId],
    );
    const row = rows.rows[0];
    if (row === undefined) return;
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${row.id}/stop`,
      headers: auth(caller, `stop-${row.id}-${sequence}`),
      payload: { expectedEpoch: Number(row.epoch) },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
  }

  function clearFallback(): void {
    if (!fallbackOn) return;
    cli(db, [
      'set-fallback-policy', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--enabled', 'false',
      '--deployments', 'guard-chat', '--failures', 'unavailable', '--max-attempts', '2',
      '--capabilities', 'temperature', '--providers', 'openai', '--data-collection', 'allow',
      '--min-remaining-deadline-ms', '0',
    ]);
    fallbackOn = false;
  }

  function setFallback(failures = 'unavailable'): void {
    cli(db, [
      'set-fallback-policy', '--tenant-id', tenant.tenantId, '--alias', 'auto', '--enabled', 'true',
      '--deployments', 'guard-chat', '--failures', failures, '--max-attempts', '2',
      '--capabilities', 'temperature', '--providers', 'openai', '--data-collection', 'allow',
      '--min-remaining-deadline-ms', '0',
    ]);
    fallbackOn = true;
  }

  async function chat(caller: Tenant, content: string, extra: Record<string, unknown> = {}, routingKey?: string) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(caller, undefined, routingKey),
      payload: chatPayload('auto', content, { task: 'general_qa', ...extra }),
    });
  }

  async function assignment(requestId: string): Promise<{
    cohort: string;
    cohort_deployment: string;
    executed_deployment: string;
    hold_reason: string;
  } | null> {
    const result = await admin.query<{
      cohort: string;
      cohort_deployment: string;
      executed_deployment: string;
      hold_reason: string;
    }>(
      `SELECT a.cohort, cohort.name AS cohort_deployment, executed.name AS executed_deployment, a.hold_reason
       FROM routing_canary_assignments a
       JOIN model_deployments cohort ON cohort.tenant_id = a.tenant_id AND cohort.id = a.cohort_deployment_id
       JOIN model_deployments executed ON executed.tenant_id = a.tenant_id AND executed.id = a.executed_deployment_id
       WHERE a.request_id = $1`,
      [requestId],
    );
    return result.rows[0] ?? null;
  }

  async function rolloutStatus(id: string): Promise<{ status: string; stop_reason: string | null; epoch: number }> {
    const result = await admin.query<{ status: string; stop_reason: string | null; epoch: number }>(
      `SELECT status, stop_reason, epoch FROM routing_rollouts WHERE id = $1`,
      [id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('rollout was not stored');
    return { status: row.status, stop_reason: row.stop_reason, epoch: Number(row.epoch) };
  }

  function body(basisPoints: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      policyId,
      basisPoints,
      maxRequestCount: 1_000,
      maxExpense: '5',
      maxDurationSeconds: 86_400,
      evidenceSnapshotId: snapshotId,
      criticalErrorThreshold: 10_000,
      ...overrides,
    };
  }

  async function activate(basisPoints: number, caller: Tenant = tenant): Promise<{ id: string; epoch: number; versionId: string }> {
    await stopActive(caller);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(caller, nextKey('activate')),
      payload: body(basisPoints),
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { id: string; epoch: number; versionId: string };
  }

  function gate(kind: string, signal: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      kind,
      signal,
      threshold: 1,
      minSamples: 1,
      windowSeconds: 3_600,
      maturitySeconds: 0,
      maxMissingFraction: 1,
      margin: 0,
      ...overrides,
    };
  }

  async function attach(rolloutId: string, rules: unknown[], caller: Tenant = tenant) {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/guardrails',
      headers: auth(caller, nextKey('attach')),
      payload: { rolloutId, approvedSources: ['task-verifier'], rules },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json() as {
      id: string;
      rules: Array<{ id: string; minSamples: number; maturitySeconds: number; windowSeconds: number }>;
      metrics: MetricRow[];
      cohorts: Array<{ cohort: string; providerSuccesses: number; costSum: number; latencyP95Ms: number | null; errorRequests: number }>;
      violations: Violation[];
    };
  }

  async function view(rolloutId: string) {
    const response = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/guardrails',
      headers: auth(reader),
    });
    expect(response.statusCode, response.body).toBe(200);
    const payload = response.json() as { guardrails: GuardrailPayload[] };
    const found = payload.guardrails.find((item) => item.rolloutId === rolloutId);
    expect(found, response.body).toBeDefined();
    return found as GuardrailPayload;
  }

  async function watch(tenantIds: string[] = [tenant.tenantId]): Promise<GuardrailPassReport> {
    return runGuardrailPass(ctx.runtimePool, tenantIds);
  }

  async function feedback(caller: Tenant, requestId: string, overrides: Record<string, unknown> = {}) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: auth(caller),
      payload: {
        requestId,
        feedbackId: nextKey('fb'),
        source: 'task-verifier',
        metric: 'task_success',
        result: 'pass',
        validatorVersion: 'v1',
        timestamp: new Date().toISOString(),
        ...overrides,
      },
    });
  }

  function routingKeyFor(versionId: string, want: 'baseline' | 'canary'): string {
    for (let index = 0; index < 4_000; index += 1) {
      const routingKey = `share-${index}`;
      const assigned = assignCohort({
        tenantId: tenant.tenantId,
        alias: 'auto',
        policyVersionId: versionId,
        routingKey,
        basisPoints: 5_000,
      });
      if (assigned === want) return routingKey;
    }
    throw new Error(`no ${want} key`);
  }

  async function violationCount(rolloutId: string): Promise<number> {
    const result = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_guardrail_violations WHERE rollout_id = $1`,
      [rolloutId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async function aliasName(caller: Tenant): Promise<string> {
    const result = await admin.query<{ name: string }>(
      `SELECT d.name
       FROM model_aliases a
       JOIN model_deployments d ON d.tenant_id = a.tenant_id AND d.id = a.deployment_id
       WHERE a.tenant_id = $1 AND a.alias = 'auto'`,
      [caller.tenantId],
    );
    return result.rows[0]?.name ?? '';
  }

  beforeAll(async () => {
    mock = await startMockUpstream((_hit, _request, response) => {
      const parsed = JSON.parse(_hit.body) as { model?: string; stream?: boolean };
      const model = parsed.model ?? '';
      const script = scripts.get(model) ?? 'ok';
      if (script === 'slow') {
        setTimeout(() => {
          if (response.destroyed || response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(okBody(model));
        }, 800);
        return;
      }
      if (script === 'hold' || script === 'hold503') {
        const gate = hold;
        if (gate === null) {
          response.writeHead(500, { 'content-type': 'application/json' });
          response.end('{}');
          return;
        }
        if (script === 'hold') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(sseHead(model));
          gate.ready();
          void gate.opened.then(() => {
            if (response.destroyed || response.writableEnded) return;
            response.end(sseRest(model));
          });
          return;
        }
        gate.ready();
        void gate.opened.then(() => {
          if (response.destroyed || response.writableEnded) return;
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        });
        return;
      }
      if (script === 'partial') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseHead(model));
        return;
      }
      if (script === '500' || script === '503') {
        response.writeHead(script === '500' ? 500 : 503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'upstream', code: 'upstream' } }));
        return;
      }
      if (parsed.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`${sseHead(model)}${sseRest(model)}`);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(okBody(model));
    });
    tenant = provisionTenant(db, 'Guard A');
    other = provisionTenant(db, 'Guard B');
    registerInference(db, {
      tenantId: tenant.tenantId,
      apiKey: 'sk-guard-a',
      deployment: 'guard-chat',
      upstreamModel: 'gpt-guard-base',
    });
    cli(db, [
      'register-deployment', '--tenant-id', tenant.tenantId, '--name', 'guard-spare',
      '--upstream-model', 'gpt-guard-spare', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    registerInference(db, {
      tenantId: other.tenantId,
      apiKey: 'sk-guard-b',
      deployment: 'beta-chat',
      upstreamModel: 'gpt-guard-beta',
    });
    cli(db, [
      'register-deployment', '--tenant-id', other.tenantId, '--name', 'beta-spare',
      '--upstream-model', 'gpt-guard-beta-spare', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'guard-chat' });
    enableStreaming(db, { tenantId: tenant.tenantId, deployment: 'guard-spare' });
    for (const name of ['guard-chat', 'guard-spare']) {
      cli(db, ['set-deployment-data-collection', '--tenant-id', tenant.tenantId, '--deployment', name, '--data-collection', 'allow']);
      cli(db, ['set-deployment-context-limit', '--tenant-id', tenant.tenantId, '--deployment', name, '--context-limit', '128']);
    }
    for (const name of ['beta-chat', 'beta-spare']) {
      cli(db, ['set-deployment-data-collection', '--tenant-id', other.tenantId, '--deployment', name, '--data-collection', 'allow']);
      cli(db, ['set-deployment-context-limit', '--tenant-id', other.tenantId, '--deployment', name, '--context-limit', '128']);
    }
    cli(db, [
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
      '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
      '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    cli(db, [
      'set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare', '--enabled', 'false',
    ]);
    cli(db, [
      'set-deployment-breaker', '--tenant-id', other.tenantId, '--deployment', 'beta-spare', '--enabled', 'false',
    ]);
    cli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-guard-spare',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.01',
    ]);
    cli(db, [
      'register-price', '--provider', 'openai', '--upstream-model', 'gpt-guard-beta-spare',
      '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.01',
    ]);
    admin = adminPool(db);
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = ANY($2::text[])`,
      [tenant.tenantId, ['guard-chat', 'guard-spare']],
    );
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = $1 AND name = ANY($2::text[])`,
      [other.tenantId, ['beta-chat', 'beta-spare']],
    );
    const config = await admin.query<{ config_version: number }>(
      `SELECT config_version FROM model_deployments WHERE tenant_id = $1 AND name = 'guard-spare'`,
      [tenant.tenantId],
    );
    spareConfig = Number(config.rows[0]?.config_version ?? 0);
    expect(spareConfig).toBeGreaterThan(0);
    ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    const readKey = cli(db, ['add-key', '--tenant-id', tenant.tenantId, '--label', 'guard-read']) as { keyId: string; secret: string };
    const writeKey = cli(db, ['add-key', '--tenant-id', tenant.tenantId, '--label', 'guard-admin']) as { keyId: string; secret: string };
    const plainKey = cli(db, ['add-key', '--tenant-id', tenant.tenantId, '--label', 'guard-plain']) as { keyId: string; secret: string };
    reader = { ...tenant, keyId: readKey.keyId, secret: readKey.secret };
    writer = { ...tenant, keyId: writeKey.keyId, secret: writeKey.secret };
    plain = { ...tenant, keyId: plainKey.keyId, secret: plainKey.secret };
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [tenant.tenantId, tenant.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [tenant.tenantId, tenant.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [tenant.tenantId, reader.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [tenant.tenantId, writer.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [other.tenantId, other.keyId]);
    await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [other.tenantId, other.keyId]);
    const profile = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: auth(tenant),
      payload: {
        name: 'guard-extract',
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
    const versionId = await qualify('qp-guard-main');
    snapshotId = await insertSnapshot(versionId, 'main');
    const policy = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(tenant, nextKey('policy')),
      payload: {
        name: 'guard-shadow',
        alias: 'auto',
        baselineDeployment: 'guard-chat',
        candidateDeployments: ['guard-chat', 'guard-spare'],
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
  });

  async function qualify(name: string, caller: Tenant = tenant, candidate = 'guard-spare', model = 'gpt-guard-spare', configVersion = spareConfig): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/qualification-profiles',
      headers: auth(caller, nextKey(name)),
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

  async function insertSnapshot(versionId: string, name: string, caller: Tenant = tenant): Promise<string> {
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO evidence_snapshots (
         tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
         idempotency_key, request_hash, created_at
       ) VALUES (
         $1, $2, '{}'::uuid[], 1, 20, $3, $4, statement_timestamp()
       ) RETURNING id::text AS id`,
      [caller.tenantId, versionId, nextKey(name), HASH],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('snapshot was not stored');
    await admin.query(
      `INSERT INTO evidence_candidate_assessments (
         tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
         challenger_passes, challenger_trials, original_passes, original_trials
       ) VALUES ($1, $2, 'qualified', '{}', 0.9, 1, 0, 20, 20, 20, 20)`,
      [caller.tenantId, id],
    );
    return id;
  }

  afterEach(async () => {
    scripts.clear();
    hold?.release();
    hold = null;
    clearFallback();
    await stopActive();
  });

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'guardrail-cases.json'), `${JSON.stringify(cases, null, 2)}\n`);
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await mock.close();
  });

  it('rejects bad feedback and stores an approved record without a prompt', async () => {
    const rollout = await activate(10_000);
    const first = await chat(tenant, 'feedback-request');
    expect(first.statusCode, first.body).toBe(200);
    const requestId = String(first.headers['x-request-id']);
    const early = await feedback(plain, requestId);
    expect(early.statusCode, early.body).toBe(400);
    expect(early.json().error.code).toBe('unapproved_source');
    await attach(rollout.id, [gate('absolute_failure', 'error_rate', { minSamples: 30, threshold: 1 })]);
    const anonymous = await ctx.app.inject({ method: 'POST', url: '/v1/feedback', payload: { metric: 'task_success' } });
    expect(anonymous.statusCode).toBe(401);
    const metric = await feedback(plain, requestId, { metric: 'bleu' });
    expect(metric.statusCode).toBe(400);
    expect(metric.json().error.message).toBe('metric is invalid.');
    const prompt = await feedback(plain, requestId, { prompt: 'hidden' });
    expect(prompt.statusCode).toBe(400);
    expect(prompt.json().error.message).toBe('The feedback body contains a prompt or a model output.');
    const output = await feedback(plain, requestId, { completion: 'hidden' });
    expect(output.statusCode).toBe(400);
    const unknown = await feedback(plain, requestId, { note: 'extra' });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error.message).toBe('The feedback body is invalid.');
    const huge = await ctx.app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: auth(plain),
      payload: { requestId, feedbackId: 'too-big', source: 'task-verifier', metric: 'task_success', result: 'pass', validatorVersion: 'v1', timestamp: new Date().toISOString(), pad: 'x'.repeat(5_000) },
    });
    expect(huge.statusCode).toBe(413);
    const wrong = await feedback(other, requestId);
    expect(wrong.statusCode, wrong.body).toBe(404);
    expect(wrong.json().error.message).toBe('The request was not found.');
    const unapproved = await feedback(plain, requestId, { source: 'other-source' });
    expect(unapproved.statusCode).toBe(400);
    expect(unapproved.json().error.code).toBe('unapproved_source');
    const stamp = '2026-10-30T00:00:00.000Z';
    const created = await feedback(plain, requestId, { feedbackId: 'fb-once', result: 'pass', timestamp: stamp });
    expect(created.statusCode, created.body).toBe(201);
    const replay = await feedback(plain, requestId, { feedbackId: 'fb-once', result: 'pass', timestamp: stamp });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(created.json().id);
    const conflict = await feedback(plain, requestId, { feedbackId: 'fb-once', result: 'fail' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('idempotency_conflict');
    const second = await feedback(plain, requestId, { feedbackId: 'fb-other', result: 'fail' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('feedback_conflict');
    const replaced = await feedback(plain, requestId, { feedbackId: 'fb-next', result: 'fail', supersededFeedbackId: 'fb-once' });
    expect(replaced.statusCode, replaced.body).toBe(201);
    const columns = await admin.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'routing_task_feedback' ORDER BY column_name`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toContain('prompt');
    expect(names).not.toContain('output');
    expect(names).not.toContain('completion');
    const stored = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_task_feedback WHERE request_id = $1`,
      [requestId],
    );
    expect(Number(stored.rows[0]?.count)).toBe(2);
    const denied = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/guardrails',
      headers: auth(writer),
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.message).toBe('The credential cannot use this route.');
    const empty = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/guardrails?tenantId=${other.tenantId}`,
      headers: auth(reader),
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ guardrails: [] });
  });

  it('keeps a small or immature sample and missing feedback from stopping the rollout', async () => {
    const rollout = await activate(10_000);
    const attached = await attach(rollout.id, [{ kind: 'absolute_failure', signal: 'error_rate', threshold: 0.01 }]);
    expect(attached.rules[0]?.minSamples).toBe(30);
    expect(attached.rules[0]?.maturitySeconds).toBe(300);
    scripts.set('gpt-guard-spare', '500');
    const failed = await chat(tenant, 'too-few');
    expect(failed.statusCode).toBe(502);
    const quiet = await watch();
    expect(quiet.stops).toBe(0);
    expect((await rolloutStatus(rollout.id)).status).toBe('active');
    await stopActive();
    const delayed = await activate(10_000);
    await attach(delayed.id, [gate('deterministic_quality', 'task_success', { maturitySeconds: 3_600, threshold: 0.1, maxMissingFraction: 1 })]);
    scripts.set('gpt-guard-spare', 'ok');
    const recent = await chat(tenant, 'delayed');
    expect(recent.statusCode, recent.body).toBe(200);
    const late = await feedback(tenant, String(recent.headers['x-request-id']), { result: 'fail', metric: 'task_success' });
    expect(late.statusCode, late.body).toBe(201);
    const waited = await watch();
    expect(waited.stops).toBe(0);
    expect((await rolloutStatus(delayed.id)).status).toBe('active');
    const shown = await view(delayed.id);
    const canaryRow = shown.cohorts.find((item) => item.cohort === 'canary');
    expect(canaryRow?.providerSuccesses).toBeGreaterThan(0);
    expect(canaryRow?.taskSuccesses).toBe(0);
    expect(canaryRow?.taskImmature).toBeGreaterThan(0);
    await stopActive();
    const absent = await activate(10_000);
    await attach(absent.id, [gate('deterministic_quality', 'schema_valid', { maxMissingFraction: 0.2, threshold: 0.1 })]);
    const unanswered = await chat(tenant, 'missing-feedback');
    expect(unanswered.statusCode, unanswered.body).toBe(200);
    const skipped = await watch();
    expect(skipped.stops).toBe(0);
    const missingView = await view(absent.id);
    const missingCohort = missingView.cohorts.find((item) => item.cohort === 'canary');
    expect(missingCohort?.providerSuccesses).toBeGreaterThan(0);
    expect(missingCohort?.schemaMissing).toBeGreaterThan(0);
    expect(missingCohort?.schemaPasses).toBe(0);
    expect((await rolloutStatus(absent.id)).status).toBe('active');
    cases.delayed = { reason: 'immature', status: 'active' };
    cases.missing = { reason: 'missing_feedback', providerSuccesses: missingCohort?.providerSuccesses, schemaPasses: 0 };
  });

  it('stops on error, timeout, truncation, latency, cost, schema, and correctness gates', async () => {
    scripts.set('gpt-guard-spare', '500');
    const errors = await activate(10_000);
    await attach(errors.id, [gate('absolute_failure', 'error_rate')]);
    const broken = await chat(tenant, 'error-rate');
    expect(broken.statusCode).toBe(502);
    const errorRow = await assignment(String(broken.headers['x-request-id']));
    expect(errorRow?.cohort).toBe('canary');
    expect(errorRow?.cohort_deployment).toBe('guard-spare');
    expect(errorRow?.executed_deployment).toBe('guard-spare');
    const beforeStop = await view(errors.id);
    const errorSeries = beforeStop.metrics.find((row) => row.cohort === 'canary');
    expect(errorSeries?.errorRate).toBe(1);
    expect(errorSeries?.providerSuccesses).toBe(0);
    expect(errorSeries?.evaluationQuality).toEqual({ pass: 0, fail: 0, unknown: 0 });
    const detected = await watch();
    expect(detected.stops).toBe(1);
    expect(detected.readFailures).toBe(0);
    console.log(`GUARDRAIL_DETECTION_MS ${detected.detectionMs.toFixed(3)}`);
    console.log(`GUARDRAIL_ROLLBACK_MS ${detected.rollbackMs.toFixed(3)}`);
    console.log(`GUARDRAIL_MONITOR_MS ${detected.monitorMs.toFixed(3)}`);
    console.log(`GUARDRAIL_MONITOR_ROWS ${detected.monitorRows}`);
    console.log(`GUARDRAIL_WORKER_HEAP_BYTES ${detected.heapUsed}`);
    expect((await rolloutStatus(errors.id)).stop_reason).toBe('critical_errors');
    const errorView = await view(errors.id);
    expect(errorView.violations).toHaveLength(1);
    expect(errorView.violations[0]?.trigger).toBe('guardrail');
    expect(errorView.violations[0]?.signal).toBe('error_rate');
    scripts.set('gpt-guard-spare', 'ok');
    const afterError = await chat(tenant, 'after-error');
    expect(afterError.statusCode, afterError.body).toBe(200);
    expect(afterError.json().model).toBe('gpt-guard-base');
    expect(await assignment(String(afterError.headers['x-request-id']))).toBeNull();
    console.log(`GUARDRAIL_LAST_CANARY ${broken.headers['x-deployment']}`);
    console.log(`GUARDRAIL_NEXT_BASELINE ${afterError.json().model}`);
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, 'guardrail-measurements.json'),
      `${JSON.stringify({
        detectionMs: detected.detectionMs,
        rollbackMs: detected.rollbackMs,
        monitorMs: detected.monitorMs,
        monitorRows: detected.monitorRows,
        heapUsed: detected.heapUsed,
        lastCanary: broken.headers['x-deployment'],
        nextBaseline: afterError.json().model,
        violation: errorView.violations[0],
      }, null, 2)}\n`,
    );
    cases.errorRate = { status: 'stopped', signal: 'error_rate', series: errorSeries };

    scripts.set('gpt-guard-spare', 'slow');
    cli(db, [
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
      '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '200',
      '--total-deadline-ms', '1000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    try {
      const timeouts = await activate(10_000);
      await attach(timeouts.id, [gate('absolute_failure', 'timeout_rate')]);
      const slow = await chat(tenant, 'timeout-rate');
      expect(slow.statusCode).toBeGreaterThanOrEqual(500);
      const timeoutClass = await admin.query<{ failure_class: string | null }>(
        `SELECT failure_class FROM model_attempts WHERE request_id = $1 ORDER BY attempt_ordinal DESC LIMIT 1`,
        [String(slow.headers['x-request-id'])],
      );
      expect(timeoutClass.rows[0]?.failure_class).toMatch(/timeout|total_deadline/);
      const timeoutPass = await watch();
      expect(timeoutPass.stops).toBe(1);
      expect((await view(timeouts.id)).violations[0]?.signal).toBe('timeout_rate');
      cases.timeout = { failureClass: timeoutClass.rows[0]?.failure_class, status: 'stopped' };
    } finally {
      cli(db, [
        'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
        '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
        '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
      ]);
      scripts.set('gpt-guard-spare', 'ok');
    }

    scripts.set('gpt-guard-spare', 'partial');
    const truncated = await activate(10_000);
    await attach(truncated.id, [gate('absolute_failure', 'incomplete_stream_rate')]);
    const partial = await chat(tenant, 'truncated', { stream: true });
    expect(partial.body).toContain('gpt-guard-spare');
    expect(partial.body).not.toContain('gpt-guard-base');
    const partialClass = await admin.query<{ failure_class: string | null }>(
      `SELECT failure_class FROM model_attempts WHERE request_id = $1 ORDER BY attempt_ordinal DESC LIMIT 1`,
      [String(partial.headers['x-request-id'])],
    );
    expect(partialClass.rows[0]?.failure_class).toBe('stream_started');
    expect((await watch()).stops).toBe(1);
    expect((await view(truncated.id)).violations[0]?.signal).toBe('incomplete_stream_rate');
    scripts.set('gpt-guard-spare', 'ok');
    cases.truncation = { failureClass: 'stream_started', status: 'stopped' };

    const latency = await activate(10_000);
    await attach(latency.id, [gate('latency', 'latency_p95', { threshold: 0 })]);
    const timed = await chat(tenant, 'latency');
    expect(timed.statusCode, timed.body).toBe(200);
    const latencyView = await view(latency.id);
    const latencyCohort = latencyView.cohorts.find((item) => item.cohort === 'canary');
    expect(latencyCohort?.latencySamples).toBeGreaterThan(0);
    expect((await watch()).stops).toBe(1);
    expect((await view(latency.id)).violations[0]?.signal).toBe('latency_p95');
    cases.latency = { latencyP95Ms: latencyCohort?.latencyP95Ms, status: 'stopped' };

    const spend = await activate(10_000);
    await attach(spend.id, [gate('spending', 'cost_sum', { threshold: 0.001 })]);
    const priced = await chat(tenant, 'spend');
    expect(priced.statusCode, priced.body).toBe(200);
    const spendView = await view(spend.id);
    const spendCohort = spendView.cohorts.find((item) => item.cohort === 'canary');
    expect(spendCohort?.costSum, JSON.stringify(spendCohort)).toBeGreaterThan(0);
    expect((await watch()).stops).toBe(1);
    expect((await view(spend.id)).violations[0]?.signal).toBe('cost_sum');
    cases.cost = { costSum: spendCohort?.costSum, status: 'stopped' };

    const schema = await activate(10_000);
    await attach(schema.id, [gate('deterministic_quality', 'schema_valid')]);
    const schemaChat = await chat(tenant, 'schema');
    expect(schemaChat.statusCode, schemaChat.body).toBe(200);
    const schemaFeedback = await feedback(tenant, String(schemaChat.headers['x-request-id']), { metric: 'schema_valid', result: 'fail' });
    expect(schemaFeedback.statusCode, schemaFeedback.body).toBe(201);
    expect((await watch()).stops).toBe(1);
    expect((await view(schema.id)).violations[0]?.signal).toBe('schema_valid');
    cases.schema = { status: 'stopped' };

    const correctness = await activate(10_000);
    await attach(correctness.id, [gate('deterministic_quality', 'correctness')]);
    const correctChat = await chat(tenant, 'correct');
    expect(correctChat.statusCode, correctChat.body).toBe(200);
    const correctFeedback = await feedback(tenant, String(correctChat.headers['x-request-id']), { metric: 'correctness', result: 'fail' });
    expect(correctFeedback.statusCode, correctFeedback.body).toBe(201);
    expect((await watch()).stops).toBe(1);
    expect((await view(correctness.id)).violations[0]?.signal).toBe('correctness');
    cases.correctness = { status: 'stopped' };

    const capability = await activate(10_000);
    await attach(capability.id, [gate('capability', 'capability_violation')]);
    const denied = await chat(tenant, 'capability', { top_p: 0.2 });
    expect(denied.statusCode).toBe(400);
    expect(denied.json().error.code).toBe('unsupported_parameter');
    expect((await watch()).stops).toBe(1);
    expect((await view(capability.id)).violations[0]?.signal).toBe('capability_violation');
    const next = await chat(tenant, 'after-capability');
    expect(next.json().model).toBe('gpt-guard-base');
    cases.capability = { status: 'stopped' };
  });

  it('does not stop when relative quality still overlaps', async () => {
    const rollout = await activate(5_000);
    const baselineKey = routingKeyFor(rollout.versionId, 'baseline');
    const canaryKey = routingKeyFor(rollout.versionId, 'canary');
    const baselineChat = await chat(tenant, 'overlap-base', {}, baselineKey);
    const canaryChat = await chat(tenant, 'overlap-canary', {}, canaryKey);
    expect(baselineChat.statusCode, baselineChat.body).toBe(200);
    expect(canaryChat.statusCode, canaryChat.body).toBe(200);
    expect((await assignment(String(baselineChat.headers['x-request-id'])))?.cohort).toBe('baseline');
    expect((await assignment(String(canaryChat.headers['x-request-id'])))?.cohort).toBe('canary');
    await attach(rollout.id, [gate('quality_regression', 'task_success', { margin: 0.05, threshold: 0.5 })]);
    expect((await feedback(tenant, String(baselineChat.headers['x-request-id']), { result: 'pass' })).statusCode).toBe(201);
    expect((await feedback(tenant, String(canaryChat.headers['x-request-id']), { result: 'pass' })).statusCode).toBe(201);
    const report = await watch();
    expect(report.stops).toBe(0);
    expect((await rolloutStatus(rollout.id)).status).toBe('active');
    const shown = await view(rollout.id);
    expect(shown.cohorts.map((item) => item.cohort).sort()).toEqual(['baseline', 'canary']);
    const canaryMetrics = shown.metrics.find((row) => row.cohort === 'canary');
    expect(canaryMetrics?.cohortDeployment).toBe('guard-spare');
    expect(canaryMetrics?.executedDeployment).toBe('guard-spare');
    expect(canaryMetrics?.trustedQuality.taskSuccess.pass).toBe(1);
    cases.overlap = { status: 'active', cohorts: shown.cohorts.map((item) => item.cohort) };
  });

  it('stops once when two rollbacks race and rejects promotion', async () => {
    const rollout = await activate(10_000);
    const conflict = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(writer, nextKey('second-active')),
      payload: body(10_000),
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('activation_conflict');
    const promote = ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, nextKey('promote')),
      payload: { expectedEpoch: rollout.epoch, promote: true },
    });
    const first = ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, nextKey('race-a')),
      payload: { expectedEpoch: rollout.epoch },
    });
    const second = ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, nextKey('race-b')),
      payload: { expectedEpoch: rollout.epoch },
    });
    const [promoted, left, right] = await Promise.all([promote, first, second]);
    expect(promoted.statusCode).toBe(400);
    expect(promoted.json().error.code).toBe('promotion_rejected');
    expect(promoted.json().error.message).toBe('A canary cannot promote itself.');
    const statuses = [left.statusCode, right.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    expect(await aliasName(tenant)).toBe('guard-chat');
    expect((await rolloutStatus(rollout.id)).status).toBe('stopped');
    expect(await violationCount(rollout.id)).toBe(1);
    const winner = left.statusCode === 200 ? left : right;
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, winner.headers['idempotency-key'] === undefined ? nextKey('replay') : String(left.statusCode === 200 ? left.headers : right.headers)),
      payload: { expectedEpoch: rollout.epoch },
    });
    const winnerKey = left.statusCode === 200 ? 'race-a' : 'race-b';
    const storedKey = await admin.query<{ idempotency_key: string }>(
      `SELECT idempotency_key FROM routing_guardrail_violations WHERE rollout_id = $1`,
      [rollout.id],
    );
    const replayed = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, String(storedKey.rows[0]?.idempotency_key)),
      payload: { expectedEpoch: rollout.epoch },
    });
    expect(replayed.statusCode, replayed.body).toBe(200);
    expect(replayed.json().violation.trigger).toBe('operator');
    expect(await violationCount(rollout.id)).toBe(1);
    const stale = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, nextKey('stale')),
      payload: { expectedEpoch: rollout.epoch },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale_activation');
    const readerDenied = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(reader, nextKey('reader-rollback')),
      payload: { expectedEpoch: rollout.epoch + 1 },
    });
    expect(readerDenied.statusCode).toBe(403);
    await expect(
      admin.query(
        `UPDATE routing_rollouts SET status = 'active', stop_reason = NULL, stopped_at = NULL WHERE id = $1`,
        [rollout.id],
      ),
    ).rejects.toThrow(/stopped rollout cannot restart/);
    const fresh = await activate(10_000);
    expect(fresh.epoch).toBe(1);
    const emergency = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${fresh.id}/stop`,
      headers: auth(writer, nextKey('emergency')),
      payload: { expectedEpoch: fresh.epoch },
    });
    expect(emergency.statusCode, emergency.body).toBe(200);
    expect(emergency.json().stopReason).toBe('manual');
    expect(await violationCount(fresh.id)).toBe(0);
    cases.rollback = { concurrentStatuses: statuses, alias: 'guard-chat', violations: 1, winnerKey };
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(
      join(EVIDENCE, 'rollback-events.json'),
      `${JSON.stringify({
        rolloutId: rollout.id,
        stopReason: 'critical_errors',
        trigger: 'operator',
        statuses,
        alias: 'guard-chat',
        emergencyStopReason: 'manual',
        emergencyViolations: 0,
      }, null, 2)}\n`,
    );
    expect(replay.statusCode).toBeGreaterThan(0);
  });

  it('keeps an open stream and an in-flight fallback on the pinned deployment', async () => {
    const rollout = await activate(10_000);
    await attach(rollout.id, [gate('absolute_failure', 'fallback_rate', { minSamples: 100 })]);
    await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const address = ctx.app.server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    scripts.set('gpt-guard-spare', 'hold');
    const gateHold = armHold();
    const responsePromise = fetch(`http://127.0.0.1:${address.port}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(tenant),
      body: chatPayload('auto', 'stream-hold', { task: 'general_qa', stream: true }),
    });
    await gateHold.seen;
    const rolling = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
      headers: auth(writer, nextKey('stream-rollback')),
      payload: { expectedEpoch: rollout.epoch },
    });
    expect(rolling.statusCode, rolling.body).toBe(200);
    gateHold.release();
    const response = await responsePromise;
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('x-deployment')).toBe('guard-spare');
    expect(text).toContain('gpt-guard-spare');
    expect(text).not.toContain('gpt-guard-base');
    expect(mock.hits.filter((hit) => hit.body.includes('stream-hold')).map(modelOf)).toEqual(['gpt-guard-spare']);
    console.log('GUARDRAIL_INFLIGHT stream stayed on gpt-guard-spare');
    const after = await chat(tenant, 'after-stream');
    expect(after.json().model).toBe('gpt-guard-base');

    const fallbackRollout = await activate(10_000);
    await attach(fallbackRollout.id, [gate('absolute_failure', 'fallback_rate', { minSamples: 100 })]);
    setFallback();
    scripts.set('gpt-guard-spare', 'hold503');
    const fallbackHold = armHold();
    const pending = chat(tenant, 'fallback-hold');
    await fallbackHold.seen;
    const during = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${fallbackRollout.id}/rollback`,
      headers: auth(writer, nextKey('fallback-rollback')),
      payload: { expectedEpoch: fallbackRollout.epoch },
    });
    expect(during.statusCode, during.body).toBe(200);
    fallbackHold.release();
    const fell = await pending;
    expect(fell.statusCode, fell.body).toBe(200);
    expect(fell.json().model).toBe('gpt-guard-base');
    expect(fell.headers['x-fallback']).toBe('true');
    const fellRow = await assignment(String(fell.headers['x-request-id']));
    expect(fellRow?.cohort).toBe('canary');
    expect(fellRow?.cohort_deployment).toBe('guard-spare');
    expect(fellRow?.executed_deployment).toBe('guard-chat');
    expect(mock.hits.filter((hit) => hit.body.includes('fallback-hold')).map(modelOf)).toEqual(['gpt-guard-spare', 'gpt-guard-base']);
    const shown = await view(fallbackRollout.id);
    const split = shown.metrics.find((row) => row.cohort === 'canary' && row.executedDeployment === 'guard-chat');
    expect(split?.cohortDeployment).toBe('guard-spare');
    expect(split?.fallbackRate).toBe(1);
    const later = await chat(tenant, 'after-fallback');
    expect(later.json().model).toBe('gpt-guard-base');
    cases.inflight = { stream: 'gpt-guard-spare', fallbackCohort: 'canary', fallbackExecuted: 'guard-chat' };
  });

  it('uses the baseline when the rollout cannot be read and does not invent a violation', async () => {
    const rollout = await activate(10_000);
    await attach(rollout.id, [gate('absolute_failure', 'error_rate', { threshold: 0 })]);
    await admin.query('REVOKE SELECT ON routing_rollouts FROM llm_runtime');
    try {
      const response = await chat(tenant, 'safety-unreadable');
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-guard-base');
      const row = await assignment(String(response.headers['x-request-id']));
      expect(row?.hold_reason).toBe('safety_unreadable');
      expect(row?.cohort).toBe('baseline');
      const report = await watch();
      expect(report.stops).toBe(0);
      expect(report.readFailures).toBeGreaterThan(0);
    } finally {
      await admin.query('GRANT SELECT ON routing_rollouts TO llm_runtime');
    }
    expect((await rolloutStatus(rollout.id)).status).toBe('active');
    expect(await violationCount(rollout.id)).toBe(0);
    await admin.query('REVOKE SELECT ON routing_canary_assignments FROM llm_runtime');
    try {
      const during = await chat(tenant, 'metrics-unreadable');
      expect(during.statusCode, during.body).toBe(200);
      expect(during.json().model).toBe('gpt-guard-base');
      const duringRow = await assignment(String(during.headers['x-request-id']));
      expect(duringRow?.hold_reason).toBe('safety_unreadable');
      expect(duringRow?.cohort).toBe('baseline');
      const report = await watch();
      expect(report.stops).toBe(0);
      expect(report.readFailures).toBeGreaterThan(0);
      expect((await rolloutStatus(rollout.id)).status).toBe('active');
      expect(await violationCount(rollout.id)).toBe(0);
    } finally {
      await admin.query('GRANT SELECT ON routing_canary_assignments TO llm_runtime');
    }
    expect((await rolloutStatus(rollout.id)).status).toBe('active');
    expect(await violationCount(rollout.id)).toBe(0);
    const still = await chat(tenant, 'after-grant');
    expect(still.statusCode, still.body).toBe(200);
    expect(still.json().model).toBe('gpt-guard-spare');
    cases.controlPlane = { status: 'active', violations: 0, metricReadModel: 'gpt-guard-base' };
  });

  it('counts a rescued canary failure and does not treat fallback as a retry', async () => {
    setFallback('upstream_error,timeout_after_dispatch');
    scripts.set('gpt-guard-spare', '500');
    const errors = await activate(10_000);
    await attach(errors.id, [gate('absolute_failure', 'error_rate')]);
    const rescued = await chat(tenant, 'rescued-error');
    expect(rescued.statusCode, rescued.body).toBe(200);
    expect(rescued.json().model).toBe('gpt-guard-base');
    expect(rescued.headers['x-fallback']).toBe('true');
    const rescuedRow = await assignment(String(rescued.headers['x-request-id']));
    expect(rescuedRow?.cohort).toBe('canary');
    expect(rescuedRow?.cohort_deployment).toBe('guard-spare');
    expect(rescuedRow?.executed_deployment).toBe('guard-chat');
    const attempts = await admin.query<{ attempt_ordinal: number; trigger_reason: string; failure_class: string | null; deployment: string }>(
      `SELECT ma.attempt_ordinal, ma.trigger_reason, ma.failure_class, d.name AS deployment
       FROM model_attempts ma
       JOIN model_deployments d ON d.tenant_id = ma.tenant_id AND d.id = ma.deployment_id
       WHERE ma.request_id = $1
       ORDER BY ma.attempt_ordinal`,
      [String(rescued.headers['x-request-id'])],
    );
    expect(attempts.rows.map((row) => row.trigger_reason)).toEqual(['primary', 'upstream_error']);
    expect(attempts.rows[0]?.failure_class).toBe('upstream_error');
    expect(attempts.rows[0]?.deployment).toBe('guard-spare');
    const errorShown = await view(errors.id);
    const errorSeries = errorShown.metrics.find((row) => row.cohort === 'canary' && row.executedDeployment === 'guard-chat');
    expect(errorSeries?.errorRate).toBe(1);
    expect(errorSeries?.retryRate).toBe(0);
    expect(errorSeries?.fallbackRate).toBe(1);
    expect(errorSeries?.providerSuccesses).toBe(1);
    const errorStop = await watch();
    expect(errorStop.stops).toBe(1);
    expect((await view(errors.id)).violations[0]?.signal).toBe('error_rate');

    scripts.set('gpt-guard-spare', 'slow');
    cli(db, [
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
      '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '200',
      '--total-deadline-ms', '1000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    try {
      const timeouts = await activate(10_000);
      await attach(timeouts.id, [gate('absolute_failure', 'timeout_rate')]);
      const slow = await chat(tenant, 'rescued-timeout');
      expect(slow.statusCode, slow.body).toBe(200);
      expect(slow.json().model).toBe('gpt-guard-base');
      expect(slow.headers['x-fallback']).toBe('true');
      const timeoutShown = await view(timeouts.id);
      const timeoutSeries = timeoutShown.metrics.find((row) => row.cohort === 'canary');
      expect(timeoutSeries?.timeoutRate).toBe(1);
      expect(timeoutSeries?.providerSuccesses).toBe(1);
      expect((await watch()).stops).toBe(1);
      expect((await view(timeouts.id)).violations[0]?.signal).toBe('timeout_rate');
      cases.rescuedTimeout = { timeoutRate: timeoutSeries?.timeoutRate, status: 'stopped' };
    } finally {
      cli(db, [
        'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
        '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
        '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
      ]);
      scripts.set('gpt-guard-spare', 'ok');
    }

    setFallback('upstream_error');
    scripts.set('gpt-guard-spare', '500');
    const retries = await activate(10_000);
    await attach(retries.id, [gate('absolute_failure', 'retry_rate')]);
    const fallbackOnly = await chat(tenant, 'rescued-retry');
    expect(fallbackOnly.statusCode, fallbackOnly.body).toBe(200);
    const retryShown = await view(retries.id);
    const retrySeries = retryShown.metrics.find((row) => row.cohort === 'canary' && row.executedDeployment === 'guard-chat');
    expect(retrySeries?.retryRate).toBe(0);
    expect(retrySeries?.fallbackRate).toBe(1);
    expect(retrySeries?.errorRate).toBe(1);
    expect((await watch()).stops).toBe(0);
    expect((await rolloutStatus(retries.id)).status).toBe('active');

    clearFallback();
    cli(db, [
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
      '--retries', 'true', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
      '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    try {
      scripts.set('gpt-guard-spare', '503');
      const real = await activate(10_000);
      await attach(real.id, [gate('absolute_failure', 'retry_rate')]);
      const retried = await chat(tenant, 'real-retry');
      expect(retried.statusCode).toBeGreaterThanOrEqual(500);
      const reasons = await admin.query<{ trigger_reason: string }>(
        `SELECT trigger_reason FROM model_attempts WHERE request_id = $1 ORDER BY attempt_ordinal`,
        [String(retried.headers['x-request-id'])],
      );
      expect(reasons.rows.map((row) => row.trigger_reason)).toEqual(['primary', 'retry']);
      const realShown = await view(real.id);
      const realSeries = realShown.metrics.find((row) => row.cohort === 'canary');
      expect(realSeries?.retryRate).toBe(1);
      expect((await watch()).stops).toBe(1);
      expect((await view(real.id)).violations[0]?.signal).toBe('retry_rate');
      cases.rescued = { errorRate: 1, retryRate: 0, fallbackRate: 1, realRetryRate: 1 };
    } finally {
      cli(db, [
        'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'guard-spare',
        '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
        '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
      ]);
      scripts.set('gpt-guard-spare', 'ok');
    }
  });

  it('stays stopped across a restart and a second database session', async () => {
    const rollout = await activate(10_000);
    const replica = createPool(ctx.config, 'runtime', undefined, 1);
    try {
      const started = performance.now();
      const stopped = await ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/rollouts/${rollout.id}/rollback`,
        headers: auth(writer, nextKey('visible')),
        payload: { expectedEpoch: rollout.epoch },
      });
      expect(stopped.statusCode, stopped.body).toBe(200);
      const seen = await withTenant(replica, tenant.tenantId, async (client) => {
        const row = await client.query<{ status: string }>(`SELECT status FROM routing_rollouts WHERE id = $1`, [rollout.id]);
        return row.rows[0]?.status ?? '';
      });
      const elapsed = Math.ceil(performance.now() - started);
      console.log(`GUARDRAIL_PROPAGATION_MS ${elapsed}`);
      expect(seen).toBe('stopped');
      expect(elapsed).toBeLessThan(2_000);
      cases.propagationMs = elapsed;
    } finally {
      await replica.end();
    }
    const restarted = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    try {
      const response = await restarted.app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: auth(tenant),
        payload: chatPayload('auto', 'after-restart', { task: 'general_qa' }),
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().model).toBe('gpt-guard-base');
      const status = await admin.query<{ status: string }>(`SELECT status FROM routing_rollouts WHERE id = $1`, [rollout.id]);
      expect(status.rows[0]?.status).toBe('stopped');
    } finally {
      await restarted.app.close();
      await restarted.authPool.end();
      await restarted.runtimePool.end();
    }
  });

  it('does not stop another tenant', async () => {
    const betaConfig = await admin.query<{ config_version: number }>(
      `SELECT config_version FROM model_deployments WHERE tenant_id = $1 AND name = 'beta-spare'`,
      [other.tenantId],
    );
    const betaVersion = Number(betaConfig.rows[0]?.config_version ?? 0);
    const otherProfile = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: auth(other),
      payload: {
        name: 'guard-beta-extract',
        taskCategory: 'extraction',
        config: { limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 }, validators: [{ id: 'json_parse', version: 1 }] },
      },
    });
    expect(otherProfile.statusCode, otherProfile.body).toBe(201);
    const created = otherProfile.json() as { id: string; version: number; versionId: string };
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${created.id}/versions/${created.version}/approve`,
      headers: auth(other),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const previousRequirement = outputRequirementId;
    outputRequirementId = created.versionId;
    const versionId = await qualify('qp-guard-beta', other, 'beta-spare', 'gpt-guard-beta-spare', betaVersion);
    const betaSnapshot = await insertSnapshot(versionId, 'beta', other);
    outputRequirementId = previousRequirement;
    const policy = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(other, nextKey('beta-policy')),
      payload: {
        name: 'beta-shadow',
        alias: 'auto',
        baselineDeployment: 'beta-chat',
        candidateDeployments: ['beta-chat', 'beta-spare'],
        qualityMinPassRate: '0.90000',
        qualityMinValidPairs: 20,
        maxCostPerRequest: '0.05000000',
        maxLatencyMs: 4000,
        taskSegments: ['general_qa'],
      },
    });
    expect(policy.statusCode, policy.body).toBe(201);
    const betaPolicyId = (policy.json() as { id: string }).id;
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${betaPolicyId}/validate`,
      headers: auth(other, nextKey('beta-validate')),
      payload: { expectedEpoch: 1 },
    })).statusCode).toBe(200);
    expect((await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${betaPolicyId}/status`,
      headers: auth(other, nextKey('beta-shadow')),
      payload: { status: 'shadow', expectedEpoch: 2 },
    })).statusCode).toBe(200);
    const savedPolicy = policyId;
    const savedSnapshot = snapshotId;
    policyId = betaPolicyId;
    snapshotId = betaSnapshot;
    const beta = await activate(10_000, other);
    policyId = savedPolicy;
    snapshotId = savedSnapshot;
    await attach(beta.id, [gate('absolute_failure', 'error_rate', { threshold: 0 })], other);
    scripts.set('gpt-guard-beta-spare', '500');
    const failed = await chat(other, 'beta-error');
    expect(failed.statusCode).toBe(502);
    const report = await watch([tenant.tenantId]);
    expect(report.stops).toBe(0);
    expect((await rolloutStatus(beta.id)).status).toBe('active');
    scripts.set('gpt-guard-beta-spare', 'ok');
    const next = await chat(other, 'beta-still');
    expect(next.statusCode, next.body).toBe(200);
    expect(next.json().model).toBe('gpt-guard-beta-spare');
    expect((await assignment(String(next.headers['x-request-id'])))?.cohort).toBe('canary');
    await stopActive(other);
    const own = await chat(tenant, 'tenant-a-baseline');
    expect(own.json().model).toBe('gpt-guard-base');
    cases.crossTenant = { betaStatus: 'active', betaModel: 'gpt-guard-beta-spare' };
  });
});

type MetricRow = {
  cohort: string;
  cohortDeployment: string;
  executedDeployment: string;
  taskSegment: string;
  assignments: number;
  executions: number;
  errorRate: number | null;
  timeoutRate: number | null;
  retryRate: number | null;
  providerSuccesses: number;
  evaluationQuality: { pass: number; fail: number; unknown: number };
  trustedQuality: { taskSuccess: { pass: number; fail: number; unknown: number } };
  fallbackRate: number | null;
};

type Violation = { trigger: string; signal: string; kind: string; reason: string };

type GuardrailPayload = {
  rolloutId: string;
  metrics: MetricRow[];
  cohorts: Array<{
    cohort: string;
    providerSuccesses: number;
    taskSuccesses: number;
    taskImmature: number;
    schemaMissing: number;
    schemaPasses: number;
    costSum: number;
    latencyP95Ms: number | null;
    latencySamples: number;
    errorRequests: number;
  }>;
  violations: Violation[];
};
