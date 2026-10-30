import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { assignCohort } from '../src/inference/canary-assignment.js';
import { latestMigrationVersion } from '../src/db/migrate.js';
import { createPool } from '../src/db/pools.js';
import { withTenant } from '../src/db/tenant-context.js';
import { runGuardrailPass } from '../src/inference/guardrail-worker.js';
import { resetShadowRankCache } from '../src/inference/shadow-rank.js';
import {
  configFor,
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
  type TestDatabase,
} from './helpers.js';
import {
  adminPool,
  chatPayload,
  cliEnv,
  credentialKey,
  credentialKeyText,
  enableStreaming,
  provisionTenant,
  registerInference,
} from './inference-support.js';
import { completionBody, startMockUpstream } from './mock-openai.js';
import {
  UPSTREAM,
  chat as matrixChat,
  defaultNames,
  doneCount,
  grewOnly,
  latestAttempt,
  listenProxy,
  openDb,
  openPost,
  registerSix,
  sceneContent,
  snapshot,
  startDoubles,
  vertexKey,
  waitFor,
  type Doubles,
  type ProviderName,
} from './hardening-support.js';

const HASH = 'cd'.repeat(32);
const EFFECTIVE = '2026-01-01T00:00:00.000Z';
const EVIDENCE = join(projectRoot, 'evidence', 'slice-08g');
const PROMPT = 'qa-secret';
const SAMPLE = 'sample-only';
const MARKER = 'EVAL-MARKER-08G';
const KEY_A = 'sk-h08g-a-secretkey';
const KEY_B = 'sk-h08g-b-secretkey';
const PARTIAL = 'data: {"id":"chatcmpl-h","object":"chat.completion.chunk","created":1,"model":"h","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"},"finish_reason":null}]}\n\n';

type Tenant = ReturnType<typeof provisionTenant>;
type App = Awaited<ReturnType<typeof createTestApp>>;
type Child = ReturnType<typeof spawnServer>;
type RankView = {
  recommendedDeployment: string | null;
  reasonCodes: string[];
  exclusions: Array<{ deployment: string; reason: string }>;
  candidateCount: number;
  cacheHit: boolean;
  savingsKind: string;
  estimatedSavings: string | null;
  computationMs: number;
};
type DecisionView = {
  routingMode: string;
  selectedDeployment: string;
  selection: { reason: string; selectedDeployment: string; baselineDeployment: string; taskSegment: string } | null;
};

const measurements: Record<string, unknown> = {
  source: 'routing-hardening.test.ts',
  labels: {
    routingCpu: 'whole-process CPU from ps, not routing-only CPU',
    routingLatency: 'nearest-rank percentile of stored computation_ms wall-clock rank time',
    addedLatency: 'client wall time minus stored model_attempts.duration_ms for the same request',
    policyLookup: 'client-observed GET policy time',
    activeStreams: 'count of model_attempts with stream_status connecting or streaming',
    lockContention: 'maximum ungranted pg_locks while delayed chats overlapped',
    predictedSavings: 'shadow estimatedSavings stays an estimate',
  },
};

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

function cpuSeconds(raw: string): number {
  const parts = raw.trim().split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return 0;
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0);
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
  return parts[0] ?? 0;
}

function processSample(pid: number | undefined): { rssKb: number; cpuSeconds: number } {
  if (pid === undefined) return { rssKb: 0, cpuSeconds: 0 };
  const result = spawnSync('ps', ['-o', 'rss=,time=', '-p', String(pid)], { encoding: 'utf8' });
  const [rss, time] = (result.stdout ?? '').trim().split(/\s+/);
  return { rssKb: Number(rss ?? 0), cpuSeconds: cpuSeconds(time ?? '0') };
}

function sse(model: string, text: string): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    `data: ${JSON.stringify({
      id: 'chatcmpl-h',
      object: 'chat.completion.chunk',
      created: 1,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  return `${chunk({ role: 'assistant', content: text }, null)}${chunk({}, 'stop')}data: [DONE]\n\n`;
}

describe('routing hardening', () => {
  const db = loadTestDatabase();
  const held: import('node:http').ServerResponse[] = [];
  let mock: Awaited<ReturnType<typeof startMockUpstream>>;
  let ctx: App;
  let admin: pg.Pool;
  let tenant: Tenant;
  let other: Tenant;
  let plain: { keyId: string; secret: string };
  let sequence = 0;
  let sampleA = '';
  let sampleB = '';
  let outputA = '';
  let outputB = '';
  let policyId = '';
  let otherPolicyId = '';
  let policyVersionId = '';
  let otherPolicyVersionId = '';
  let qualityProfile = '';
  let tieProfile = '';
  let qualityRun = '';
  let tieRun = '';
  let qualityConfig = 1;
  let rolloutId = '';
  let rolloutEpoch = 0;
  let otherRolloutId = '';
  const configs = new Map<string, number>();
  let childA: Child | undefined;
  let childB: Child | undefined;
  let measuredFrom = new Date(0);
  const admitFunction = 'admit_attempt(uuid, uuid, uuid, uuid, uuid, boolean, timestamptz, timestamptz, date, bigint, numeric, text, uuid)';
  let childC: Child | undefined;
  let portA = 0;
  let portB = 0;
  let portC = 0;
  const replicaEnv = (): Record<string, string> => ({
    INFERENCE_ENABLED: 'true',
    OPENAI_BASE_URL: mock.baseUrl,
    PROVIDER_CREDENTIAL_KEY: credentialKeyText,
    MAX_ACTIVE_STREAMS: '1',
    MAX_STREAMS_PER_TENANT: '4',
    LOG_LEVEL: 'info',
  });

  function cli(args: string[]): Record<string, unknown> {
    return runCli(db, args, cliEnv()) as Record<string, unknown>;
  }

  function nextKey(name: string): string {
    sequence += 1;
    return `h08g-${sequence}-${name}`;
  }

  function auth(caller: Tenant, idempotencyKey?: string, routingKey?: string, secret = caller.secret): Record<string, string> {
    return {
      'x-tenant-id': caller.tenantId,
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
      ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      ...(routingKey === undefined ? {} : { 'x-llm-routing-key': routingKey }),
    };
  }

  function keyFor(owner: Tenant, versionId: string, basis: number, want: 'baseline' | 'canary'): string {
    for (let index = 0; index < 8_000; index += 1) {
      const routingKey = `h08g-share-${owner.tenantId.slice(0, 8)}-${index}`;
      const assigned = assignCohort({
        tenantId: owner.tenantId,
        alias: 'auto',
        policyVersionId: versionId,
        routingKey,
        basisPoints: basis,
      });
      if (assigned === want) return routingKey;
    }
    throw new Error('no routing key');
  }

  async function chat(
    caller: Tenant,
    content: string,
    extra: Record<string, unknown> = {},
    model = 'auto',
    routingKey?: string,
  ) {
    return ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(caller, undefined, routingKey),
      payload: chatPayload(model, content, extra),
    });
  }

  async function httpChat(
    port: number,
    caller: Tenant,
    content: string,
    extra: Record<string, unknown> = {},
    model = 'auto',
    routingKey?: string,
    secret = caller.secret,
  ) {
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: auth(caller, undefined, routingKey, secret),
      body: chatPayload(model, content, extra),
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      ms: performance.now() - started,
      deployment: response.headers.get('x-deployment'),
      requestId: response.headers.get('x-request-id'),
      json(): Record<string, unknown> {
        return JSON.parse(text) as Record<string, unknown>;
      },
    };
  }

  function errorOf(body: string): { code: string; param: string | null } {
    const parsed = JSON.parse(body) as { error: { code: string; param: string | null } };
    return parsed.error;
  }

  async function approveOutput(caller: Tenant, name: string, task: string): Promise<string> {
    const profile = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/evaluation-profiles',
      headers: auth(caller),
      payload: {
        name,
        taskCategory: task,
        config: {
          limits: { maxInputChars: 4096, timeBudgetMs: 250, maxSchemaDepth: 8, maxSchemaNodes: 200 },
          validators: [{ id: 'json_parse', version: 1 }],
        },
      },
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const body = profile.json() as { id: string; version: number; versionId: string };
    const approved = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/evaluation-profiles/${body.id}/versions/${body.version}/approve`,
      headers: auth(caller),
      payload: {},
    });
    expect(approved.statusCode, approved.body).toBe(200);
    return body.versionId;
  }

  async function qualify(
    caller: Tenant,
    name: string,
    candidate: string,
    model: string,
    configVersion: number,
    task: string,
    outputRequirementId: string,
    freshnessSeconds = 2_592_000,
  ): Promise<string> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/qualification-profiles',
      headers: auth(caller, nextKey(name)),
      payload: {
        name,
        taskCategory: task,
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
        freshnessSeconds,
        minCoverage: '1.00000',
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return (created.json() as { versionId: string }).versionId;
  }

  async function seed(input: {
    caller: Tenant;
    sampleId: string;
    profileVersionId: string;
    name: string;
    cost: string;
    latency: number;
    status: string;
    reasons: string[];
    wilson: number | null;
    matched: number;
    stale: boolean;
    freshnessNote?: string;
  }): Promise<string> {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const definition = await client.query<{ id: string }>(
        `INSERT INTO evaluation_definitions (tenant_id, name) VALUES ($1, $2) RETURNING id::text AS id`,
        [input.caller.tenantId, nextKey(`def-${input.name}`)],
      );
      const definitionId = definition.rows[0]?.id;
      if (definitionId === undefined) throw new Error('definition was not stored');
      const version = await client.query<{ id: string }>(
        `INSERT INTO evaluation_definition_versions (tenant_id, definition_id, version, config)
         VALUES ($1, $2, 1, '{"mode":"dry_run","modelExecution":"off"}'::jsonb)
         RETURNING id::text AS id`,
        [input.caller.tenantId, definitionId],
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
           $5, $6, 0.25, 1, 0, 0, 0, 1, 0, 0
         ) RETURNING id::text AS id`,
        [
          input.caller.tenantId,
          definitionVersionId,
          nextKey(`run-${input.name}`),
          HASH,
          input.caller === other ? 'coding' : 'general_qa',
          input.name,
        ],
      );
      const runId = run.rows[0]?.id;
      if (runId === undefined) throw new Error('run was not stored');
      const item = await client.query<{ id: string }>(
        `INSERT INTO evaluation_items (tenant_id, run_id, sample_id, ordinal, status, reason_code)
         VALUES ($1, $2, $3, 0, 'completed', 'dry_run')
         RETURNING id::text AS id`,
        [input.caller.tenantId, runId, input.sampleId],
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
                  $2, 'succeeded', 'evaluation', statement_timestamp()
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
                $8, $8, req.deployment_config_version, 1, $9::jsonb, $5::integer, $6::numeric, $7::text
         FROM attempt
         JOIN req ON req.tenant_id = attempt.tenant_id`,
        [
          input.sampleId,
          `gpt-${input.name}`,
          runId,
          itemId,
          input.latency,
          input.cost,
          'reconciled',
          input.name,
          JSON.stringify({ marker: MARKER }),
        ],
      );
      const snapshotRow = await client.query<{ id: string }>(
        `INSERT INTO evidence_snapshots (
           tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
           idempotency_key, request_hash, created_at
         ) VALUES (
           $1, $2, ARRAY[$3]::uuid[], 1, $4, $5, $6,
           CASE WHEN $7::boolean THEN statement_timestamp() - interval '7 days' ELSE statement_timestamp() END
         ) RETURNING id::text AS id`,
        [input.caller.tenantId, input.profileVersionId, runId, input.matched, nextKey(`snap-${input.name}`), HASH, input.stale],
      );
      const snapshotId = snapshotRow.rows[0]?.id;
      if (snapshotId === undefined) throw new Error('snapshot was not stored');
      await client.query(
        `INSERT INTO evidence_candidate_assessments (
           tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
           challenger_passes, challenger_trials, original_passes, original_trials
         ) VALUES ($1, $2, $3, $4::text[], $5, $6, 0, 20, 20, 20, 20)`,
        [input.caller.tenantId, snapshotId, input.status, input.reasons, input.wilson, input.wilson === null ? null : 1],
      );
      await client.query('COMMIT');
      if (input.name === 'h08g-quality') qualityRun = runId;
      if (input.name === 'h08g-tie') tieRun = runId;
      return snapshotId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function insertSnapshot(
    caller: Tenant,
    profileVersionId: string,
    name: string,
    runId: string,
    status: string,
    reasons: string[],
    wilson: number | null,
    matched = 20,
    ageDays = 0,
  ): Promise<string> {
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO evidence_snapshots (
         tenant_id, profile_version_id, source_run_ids, coverage_rate, matched_pairs,
         idempotency_key, request_hash, created_at
       ) VALUES (
         $1, $2, ARRAY[$3]::uuid[], 1, $4, $5, $6,
         statement_timestamp() - make_interval(days => $7::int)
       )
       RETURNING id::text AS id`,
      [caller.tenantId, profileVersionId, runId, matched, nextKey(name), HASH, ageDays],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('snapshot was not stored');
    await admin.query(
      `INSERT INTO evidence_candidate_assessments (
         tenant_id, snapshot_id, status, reason_codes, wilson_lower, wilson_upper, difference_lower,
         challenger_passes, challenger_trials, original_passes, original_trials
       ) VALUES ($1, $2, $3, $4::text[], $5, $6, 0, 20, 20, 20, 20)`,
      [caller.tenantId, id, status, reasons, wilson, wilson === null ? null : 1],
    );
    return id;
  }

  async function shadowPolicy(
    caller: Tenant,
    name: string,
    baseline: string,
    candidates: string[],
    quality: string,
    segments: string[],
  ): Promise<{ id: string; versionId: string }> {
    const drafted = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(caller, nextKey(`${name}-draft`)),
      payload: {
        name,
        alias: 'auto',
        baselineDeployment: baseline,
        candidateDeployments: candidates,
        qualityMinPassRate: quality,
        qualityMinValidPairs: 20,
        maxCostPerRequest: '1.00000000',
        maxLatencyMs: 4000,
        taskSegments: segments,
      },
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const id = (drafted.json() as { id: string }).id;
    const validated = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${id}/validate`,
      headers: auth(caller, nextKey(`${name}-validate`)),
      payload: { expectedEpoch: 1 },
    });
    expect(validated.statusCode, validated.body).toBe(200);
    const shadowed = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/policies/${id}/status`,
      headers: auth(caller, nextKey(`${name}-shadow`)),
      payload: { status: 'shadow', expectedEpoch: 2 },
    });
    expect(shadowed.statusCode, shadowed.body).toBe(200);
    return { id, versionId: (shadowed.json() as { versionId: string }).versionId };
  }

  async function activate(caller: Tenant, policy: string, evidence: string, basis = 5_000): Promise<{ id: string; epoch: number; versionId: string }> {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/rollouts',
      headers: auth(caller, nextKey('activate')),
      payload: {
        policyId: policy,
        basisPoints: basis,
        maxRequestCount: 1_000,
        maxExpense: '5',
        maxDurationSeconds: 86_400,
        evidenceSnapshotId: evidence,
        criticalErrorThreshold: 10_000,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json() as { id: string; epoch: number; versionId: string };
  }

  async function promote(caller: Tenant, id: string, epoch: number, task: string, key = nextKey('promote')) {
    return ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${id}/promote`,
      headers: auth(caller, key),
      payload: { expectedEpoch: epoch, taskSegment: task, stages: [10_000], enableSelection: true },
    });
  }

  async function simulate(caller: Tenant): Promise<RankView> {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/simulate',
      headers: auth(caller, nextKey('simulate')),
      payload: { model: 'auto', messages: [{ role: 'user', content: 'qa' }], task: caller === other ? 'coding' : 'general_qa' },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as RankView;
  }

  async function decision(caller: Tenant, requestId: string, secret = caller.secret) {
    return ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/decisions/${requestId}`,
      headers: auth(caller, undefined, undefined, secret),
    });
  }

  async function restoreQuality(): Promise<void> {
    await admin.query(
      `UPDATE model_deployments
       SET upstream_model = 'gpt-h08g-quality', config_version = $2, enabled = true, validation_status = 'validated_live'
       WHERE tenant_id = $1 AND name = 'h08g-quality'`,
      [tenant.tenantId, qualityConfig],
    );
    await admin.query(
      `UPDATE model_deployments SET enabled = true, validation_status = 'validated_live'
       WHERE tenant_id = $1 AND name = 'h08g-tie'`,
      [tenant.tenantId],
    );
  }

  async function latestRequest(tenantId: string): Promise<{ status: string; failure_class: string | null; stream_status: string | null }> {
    const result = await admin.query<{ status: string; failure_class: string | null; stream_status: string | null }>(
      `SELECT request.status, attempt.failure_class, attempt.stream_status
       FROM proxy_requests request
       JOIN model_attempts attempt ON attempt.tenant_id = request.tenant_id AND attempt.request_id = request.id
       WHERE request.tenant_id = $1
       ORDER BY request.created_at DESC
       LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('request was not stored');
    return row;
  }

  function releaseHeld(): void {
    for (const response of held.splice(0)) {
      if (!response.writableEnded) response.end('data: [DONE]\n\n');
    }
  }

  beforeAll(async () => {
    mock = await startMockUpstream((hit, request, response) => {
      const parsed = JSON.parse(hit.body) as { model?: string; stream?: boolean; messages?: Array<{ content?: string }> };
      const model = parsed.model ?? '';
      const content = parsed.messages?.[0]?.content ?? '';
      const stream = parsed.stream === true;
      if (content === 'hold' && stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(PARTIAL);
        held.push(response);
        return;
      }
      if (content === 'partial' && stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(PARTIAL);
        return;
      }
      if (content === 'cancel' && stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(PARTIAL);
        return;
      }
      if (stream && content === 'stream') {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sse(model, 'stream-ok'));
        return;
      }
      if (content === 'down') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'upstream', type: 'server_error' } }));
        return;
      }
      if (content === 'fall' && model === 'gpt-h08g-quality') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unavailable', type: 'server_error' } }));
        return;
      }
      if (content === 'forced-down' && model === 'gpt-h08g-poor') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'unavailable', type: 'server_error' } }));
        return;
      }
      if (content === 'delay') {
        setTimeout(() => {
          if (response.writableEnded) return;
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(completionBody(model, 'delayed')));
        }, 700);
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(completionBody(model, `from-${model}`)));
    });
    tenant = provisionTenant(db, 'Harden A');
    other = provisionTenant(db, 'Harden B');
    const names = [
      ['h08g-base', 'gpt-h08g-base', '0.050000'],
      ['h08g-poor', 'gpt-h08g-poor', '0.010000'],
      ['h08g-stale', 'gpt-h08g-stale', '0.012000'],
      ['h08g-slow', 'gpt-h08g-slow', '0.015000'],
      ['h08g-thin', 'gpt-h08g-thin', '0.016000'],
      ['h08g-gap', 'gpt-h08g-gap', '0.017000'],
      ['h08g-wide', 'gpt-h08g-wide', '0.018000'],
      ['h08g-quality', 'gpt-h08g-quality', '0.020000'],
      ['h08g-tie', 'gpt-h08g-tie', '0.020000'],
      ['h08g-ninth', 'gpt-h08g-ninth', '0.005000'],
    ] as const;
    registerInference(db, { tenantId: tenant.tenantId, apiKey: KEY_A, deployment: 'h08g-base', upstreamModel: 'gpt-h08g-base' });
    for (const [name, model] of names.slice(1)) {
      cli([
        'register-deployment', '--tenant-id', tenant.tenantId, '--name', name,
        '--upstream-model', model, '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
      ]);
    }
    registerInference(db, { tenantId: other.tenantId, apiKey: KEY_B, deployment: 'h08g-beta-base', upstreamModel: 'gpt-h08g-beta-base' });
    cli([
      'register-deployment', '--tenant-id', other.tenantId, '--name', 'h08g-beta',
      '--upstream-model', 'gpt-h08g-beta', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    for (const [name, model, rate] of names) {
      cli(['set-deployment-data-collection', '--tenant-id', tenant.tenantId, '--deployment', name, '--data-collection', 'allow']);
      cli(['set-deployment-context-limit', '--tenant-id', tenant.tenantId, '--deployment', name, '--context-limit', '128']);
      cli(['set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', name, '--enabled', 'false']);
      enableStreaming(db, { tenantId: tenant.tenantId, deployment: name });
      cli([
        'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', name,
        '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
        '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
      ]);
      cli(['register-price', '--provider', 'openai', '--upstream-model', model, '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', rate]);
    }
    for (const [name, model, rate] of [
      ['h08g-beta-base', 'gpt-h08g-beta-base', '0.080000'],
      ['h08g-beta', 'gpt-h08g-beta', '0.020000'],
    ] as const) {
      cli(['set-deployment-data-collection', '--tenant-id', other.tenantId, '--deployment', name, '--data-collection', 'allow']);
      cli(['set-deployment-context-limit', '--tenant-id', other.tenantId, '--deployment', name, '--context-limit', '128']);
      cli(['set-deployment-breaker', '--tenant-id', other.tenantId, '--deployment', name, '--enabled', 'false']);
      enableStreaming(db, { tenantId: other.tenantId, deployment: name });
      cli([
        'set-execution-policy', '--tenant-id', other.tenantId, '--deployment', name,
        '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
        '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
      ]);
      cli(['register-price', '--provider', 'openai', '--upstream-model', model, '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', rate]);
    }
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'observe', '--monthly-amount', '5']);
    cli(['set-tenant-budget', '--tenant-id', other.tenantId, '--mode', 'observe', '--monthly-amount', '40']);
    cli(['set-deployment-data-class', '--tenant-id', tenant.tenantId, '--deployment', 'h08g-base', '--data-class', 'internal']);
    cli(['set-deployment-data-class', '--tenant-id', other.tenantId, '--deployment', 'h08g-beta-base', '--data-class', 'internal']);
    for (const [caller, deployment] of [
      [tenant, 'h08g-base'],
      [other, 'h08g-beta-base'],
    ] as const) {
      cli([
        'set-sample-policy',
        '--tenant-id', caller.tenantId,
        '--mode', 'encrypted_sample',
        '--content-capture', 'true',
        '--replay', 'true',
        '--judge-disclosure', 'true',
        '--sample-rate', '1',
        '--max-sample-bytes', '1000000',
        '--max-sample-count', '1000',
        '--retention-seconds', '86400',
        '--classifications', 'internal',
        '--providers', 'openai',
        '--deployments', deployment,
      ]);
    }
    admin = adminPool(db);
    const origin = await admin.query<{ ts: Date }>(`SELECT statement_timestamp() AS ts`);
    const originTs = origin.rows[0]?.ts;
    if (originTs === undefined) throw new Error('database clock was not read');
    measuredFrom = originTs;
    await admin.query(
      `UPDATE model_deployments SET validation_status = 'validated_live' WHERE tenant_id = ANY($1::uuid[])`,
      [[tenant.tenantId, other.tenantId]],
    );
    const versions = await admin.query<{ tenant_id: string; name: string; config_version: number }>(
      `SELECT tenant_id::text AS tenant_id, name, config_version FROM model_deployments WHERE tenant_id = ANY($1::uuid[])`,
      [[tenant.tenantId, other.tenantId]],
    );
    for (const row of versions.rows) configs.set(`${row.tenant_id}:${row.name}`, Number(row.config_version));
    qualityConfig = configs.get(`${tenant.tenantId}:h08g-quality`) ?? 0;
    expect(qualityConfig).toBeGreaterThan(0);
    ctx = await createTestApp(db, { inferenceEnabled: true, upstreamBaseUrl: mock.baseUrl, credentialKey });
    for (const caller of [tenant, other]) {
      await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:read')`, [caller.tenantId, caller.keyId]);
      await admin.query(`SELECT grant_routing_permission($1::uuid, $2::uuid, 'routing:admin')`, [caller.tenantId, caller.keyId]);
    }
    plain = cli(['add-key', '--tenant-id', tenant.tenantId, '--label', 'h08g-plain']) as { keyId: string; secret: string };
    outputA = await approveOutput(tenant, 'h08g-qa', 'extraction');
    outputB = await approveOutput(other, 'h08g-code', 'extraction');
    const capturedA = await chat(tenant, SAMPLE);
    expect(capturedA.statusCode, capturedA.body).toBe(200);
    const storedA = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    sampleA = storedA.rows[0]?.id ?? '';
    expect(sampleA).not.toBe('');
    const capturedB = await chat(other, 'b-sample');
    expect(capturedB.statusCode, capturedB.body).toBe(200);
    const storedB = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM request_samples WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [other.tenantId],
    );
    sampleB = storedB.rows[0]?.id ?? '';
    expect(sampleB).not.toBe('');
    const task = 'general_qa';
    const profiles: Array<[string, string, string, number, string, string, string, number, string, number]> = [
      ['h08g-poor', 'gpt-h08g-poor', '0.01000000', 50, 'unqualified', 'objective_threshold_failed', '0.95000', 20, 'false', 2_592_000],
      ['h08g-stale', 'gpt-h08g-stale', '0.02000000', 40, 'qualified', '', '0.95000', 20, 'true', 60],
      ['h08g-slow', 'gpt-h08g-slow', '0.03000000', 9000, 'qualified', '', '0.95000', 20, 'false', 2_592_000],
      ['h08g-thin', 'gpt-h08g-thin', '0.04000000', 30, 'qualified', '', '0.95000', 1, 'false', 2_592_000],
      ['h08g-gap', 'gpt-h08g-gap', '0.05000000', 30, 'inconclusive', 'request_distribution_gap', '0.95000', 20, 'false', 2_592_000],
      ['h08g-wide', 'gpt-h08g-wide', '0.06000000', 30, 'qualified', '', '0.50000', 20, 'false', 2_592_000],
      ['h08g-quality', 'gpt-h08g-quality', '0.10000000', 80, 'qualified', '', '0.95000', 20, 'false', 2_592_000],
      ['h08g-tie', 'gpt-h08g-tie', '0.10000000', 400, 'qualified', '', '0.95000', 20, 'false', 2_592_000],
      ['h08g-ninth', 'gpt-h08g-ninth', '0.00500000', 10, 'qualified', '', '0.95000', 20, 'false', 2_592_000],
    ];
    const snapshots = new Map<string, string>();
    for (const row of profiles) {
      const [name, model, cost, latency, status, reason, wilson, matched, stale, freshness] = row;
      const versionId = await qualify(
        tenant,
        `qp-${name}`,
        name,
        model,
        configs.get(`${tenant.tenantId}:${name}`) ?? 0,
        task,
        outputA,
        freshness,
      );
      if (name === 'h08g-quality') qualityProfile = versionId;
      if (name === 'h08g-tie') tieProfile = versionId;
      const snapshotId = await seed({
        caller: tenant,
        sampleId: sampleA,
        profileVersionId: versionId,
        name,
        cost,
        latency,
        status,
        reasons: reason === '' ? [] : [reason],
        wilson: Number(wilson),
        matched,
        stale: stale === 'true',
      });
      snapshots.set(name, snapshotId);
    }
    const betaVersion = await qualify(
      other,
      'qp-h08g-beta',
      'h08g-beta',
      'gpt-h08g-beta',
      configs.get(`${other.tenantId}:h08g-beta`) ?? 0,
      'coding',
      outputB,
    );
    const betaSnapshot = await seed({
      caller: other,
      sampleId: sampleB,
      profileVersionId: betaVersion,
      name: 'h08g-beta',
      cost: '0.02000000',
      latency: 50,
      status: 'qualified',
      reasons: [],
      wilson: 0.995,
      matched: 20,
      stale: false,
    });
    const policy = await shadowPolicy(
      tenant,
      'h08g-auto',
      'h08g-base',
      ['h08g-poor', 'h08g-stale', 'h08g-slow', 'h08g-thin', 'h08g-gap', 'h08g-wide', 'h08g-quality', 'h08g-tie'],
      '0.90000',
      ['general_qa', 'coding'],
    );
    policyId = policy.id;
    policyVersionId = policy.versionId;
    const betaPolicy = await shadowPolicy(other, 'h08g-beta-auto', 'h08g-beta-base', ['h08g-beta'], '0.99000', ['coding']);
    otherPolicyId = betaPolicy.id;
    otherPolicyVersionId = betaPolicy.versionId;
    expect(policyVersionId).not.toBe(otherPolicyVersionId);
    measurements.qualitySnapshot = snapshots.get('h08g-quality');
    measurements.betaSnapshot = betaSnapshot;
  }, 240_000);

  afterAll(async () => {
    releaseHeld();
    if (childA !== undefined) await stopChild(childA.child);
    if (childB !== undefined) await stopChild(childB.child);
    if (childC !== undefined) await stopChild(childC.child);
    mkdirSync(EVIDENCE, { recursive: true });
    writeFileSync(join(EVIDENCE, 'measurements.json'), `${JSON.stringify(measurements, null, 2)}\n`);
    await ctx.app.close();
    await ctx.authPool.end();
    await ctx.runtimePool.end();
    await admin.end();
    await mock.close();
  });

  it('ranks quality over cheaper unqualified models and records the reason codes', async () => {
    resetShadowRankCache();
    const first = await simulate(tenant);
    const second = await simulate(tenant);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(first.recommendedDeployment).toBe('h08g-quality');
    expect(first.reasonCodes).toEqual(['lowest_qualified_cost', 'latency_tie_break']);
    expect(first.candidateCount).toBe(8);
    expect(first.savingsKind).toBe('estimate');
    expect(first.exclusions.find((item) => item.deployment === 'h08g-ninth')).toBeUndefined();
    const ninthPolicy = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/policies',
      headers: auth(tenant, nextKey('ninth-policy')),
      payload: {
        name: 'h08g-ninth-policy',
        alias: 'auto',
        baselineDeployment: 'h08g-base',
        candidateDeployments: ['h08g-poor', 'h08g-stale', 'h08g-slow', 'h08g-thin', 'h08g-gap', 'h08g-wide', 'h08g-quality', 'h08g-tie', 'h08g-ninth'],
        qualityMinPassRate: '0.90000',
        qualityMinValidPairs: 20,
        maxCostPerRequest: '1.00000000',
        maxLatencyMs: 4000,
        taskSegments: ['general_qa'],
      },
    });
    expect(ninthPolicy.statusCode, ninthPolicy.body).toBe(400);
    expect(first.exclusions.find((item) => item.deployment === 'h08g-poor')?.reason).toBe('quality_failed');
    expect(first.exclusions.find((item) => item.deployment === 'h08g-stale')?.reason).toBe('evidence_stale');
    expect(first.exclusions.find((item) => item.deployment === 'h08g-slow')?.reason).toBe('latency_exceeded');
    expect(first.exclusions.find((item) => item.deployment === 'h08g-thin')?.reason).toBe('quality_failed');
    expect(first.exclusions.find((item) => item.deployment === 'h08g-gap')?.reason).toBe('quality_failed');
    expect(first.exclusions.find((item) => item.deployment === 'h08g-wide')?.reason).toBe('quality_failed');
    const gap = await admin.query<{ reason_codes: string[] }>(
      `SELECT assessment.reason_codes
       FROM evidence_candidate_assessments assessment
       JOIN evidence_snapshots snapshot ON snapshot.tenant_id = assessment.tenant_id AND snapshot.id = assessment.snapshot_id
       JOIN qualification_profile_versions profile ON profile.tenant_id = snapshot.tenant_id AND profile.id = snapshot.profile_version_id
       JOIN model_deployments deployment ON deployment.tenant_id = profile.tenant_id AND deployment.id = profile.candidate_deployment_id
       WHERE deployment.tenant_id = $1 AND deployment.name = 'h08g-gap'
       ORDER BY snapshot.created_at DESC LIMIT 1`,
      [tenant.tenantId],
    );
    expect(gap.rows[0]?.reason_codes).toContain('request_distribution_gap');
    const dropped = await insertSnapshot(tenant, qualityProfile, 'quality-invalid', qualityRun, 'unqualified', ['objective_threshold_failed'], 0.1);
    const missed = await simulate(tenant);
    expect(missed.cacheHit).toBe(false);
    expect(missed.recommendedDeployment).not.toBe('h08g-quality');
    await insertSnapshot(tenant, qualityProfile, 'quality-restored', qualityRun, 'qualified', [], 0.95);
    resetShadowRankCache();
    const restored = await simulate(tenant);
    expect(restored.recommendedDeployment).toBe('h08g-quality');
    measurements.rank = {
      winner: first.recommendedDeployment,
      reasons: first.reasonCodes,
      candidateCount: first.candidateCount,
      ninthPolicy: ninthPolicy.statusCode,
      firstCacheHit: first.cacheHit,
      secondCacheHit: second.cacheHit,
      invalidSnapshotMiss: missed.cacheHit,
      invalidWinner: missed.recommendedDeployment,
      restoredWinner: restored.recommendedDeployment,
      dropped,
      estimate: first.estimatedSavings,
      savingsKind: first.savingsKind,
    };
    console.log(`SECTION quality ${JSON.stringify(measurements.rank)}`);
  });

  it('promotes one serving policy per tenant and keeps forced and foreign traffic apart', async () => {
    const judge = await insertSnapshot(tenant, tieProfile, 'tie-judge', tieRun, 'inconclusive', ['judge_order_bias'], null);
    const targets = await admin.query<{ name: string; id: string }>(
      `SELECT name, id::text AS id FROM model_deployments WHERE tenant_id = $1 AND name IN ('h08g-base', 'h08g-tie')`,
      [tenant.tenantId],
    );
    const baseId = targets.rows.find((row) => row.name === 'h08g-base')?.id ?? '';
    const tieId = targets.rows.find((row) => row.name === 'h08g-tie')?.id ?? '';
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO routing_rollouts (
         tenant_id, policy_id, version_id, alias, basis_points, max_request_count, max_expense,
         max_duration_seconds, evidence_snapshot_id, baseline_deployment_id, challenger_deployment_id,
         critical_error_threshold, epoch, status, idempotency_key, request_hash
       ) VALUES (
         $1, $2, $3, 'auto', 5000, 1000, 5, 86400, $4, $5, $6, 10000, 1, 'active', $7, $8
       ) RETURNING id::text AS id`,
      [tenant.tenantId, policyId, policyVersionId, judge, baseId, tieId, nextKey('judge-rollout'), HASH],
    );
    const judgeRolloutId = inserted.rows[0]?.id ?? '';
    const rejected = await promote(tenant, judgeRolloutId, 1, 'general_qa');
    expect(rejected.statusCode, rejected.body).toBe(409);
    expect(errorOf(rejected.body).code).toBe('promotion_rejected');
    expect(errorOf(rejected.body).param).toBe('unstable_judge');
    const servingDuringJudge = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    expect(servingDuringJudge.rows[0]?.count).toBe(0);
    const stopped = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${judgeRolloutId}/stop`,
      headers: auth(tenant, nextKey('stop-judge')),
      payload: { expectedEpoch: 1 },
    });
    expect(stopped.statusCode, stopped.body).toBe(200);
    await insertSnapshot(tenant, tieProfile, 'tie-clean', tieRun, 'qualified', [], 0.95);
    const qualitySnapshot = await admin.query<{ id: string }>(
      `SELECT snapshot.id::text AS id
       FROM evidence_snapshots snapshot
       WHERE snapshot.profile_version_id = $1
       ORDER BY snapshot.created_at DESC, snapshot.id DESC
       LIMIT 1`,
      [qualityProfile],
    );
    const evidence = qualitySnapshot.rows[0]?.id ?? '';
    expect(evidence).not.toBe('');
    const rollout = await activate(tenant, policyId, evidence);
    rolloutId = rollout.id;
    rolloutEpoch = rollout.epoch;
    const canaryKeys = [keyFor(tenant, rollout.versionId, 5_000, 'canary'), keyFor(tenant, rollout.versionId, 5_000, 'canary')];
    const baseKeys = [keyFor(tenant, rollout.versionId, 5_000, 'baseline'), keyFor(tenant, rollout.versionId, 5_000, 'baseline')];
    for (const routingKey of canaryKeys) {
      const response = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', routingKey);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['x-deployment']).toBe('h08g-quality');
    }
    for (const routingKey of baseKeys) {
      const response = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', routingKey);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['x-deployment']).toBe('h08g-base');
    }
    const cohorts = await admin.query<{ cohort: string; count: number }>(
      `SELECT cohort, count(*)::int AS count FROM routing_canary_assignments WHERE tenant_id = $1 AND rollout_id = $2 GROUP BY cohort`,
      [tenant.tenantId, rollout.id],
    );
    const cohortMap = Object.fromEntries(cohorts.rows.map((row) => [row.cohort, row.count]));
    expect(cohortMap.canary).toBeGreaterThan(0);
    expect(cohortMap.baseline).toBeGreaterThan(0);
    const raced = await Promise.all([
      promote(tenant, rollout.id, rollout.epoch, 'general_qa', nextKey('race-a')),
      promote(tenant, rollout.id, rollout.epoch, 'general_qa', nextKey('race-b')),
    ]);
    expect(raced.map((item) => item.statusCode).sort()).toEqual([201, 409]);
    const serving = await admin.query<{ count: number; epoch: number; basis: number }>(
      `SELECT count(*)::int AS count, max(activation_epoch)::int AS epoch, max(basis_points)::int AS basis
       FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    expect(serving.rows[0]?.count).toBe(1);
    const winner = raced.find((item) => item.statusCode === 201);
    const created = winner?.json() as { activationEpoch: number; basisPoints: number };
    expect(created.activationEpoch).toBeGreaterThan(rollout.epoch);
    expect(created.basisPoints).toBe(10_000);
    const stale = await promote(tenant, rollout.id, rollout.epoch, 'general_qa');
    expect(stale.statusCode, stale.body).toBe(409);
    expect(errorOf(stale.body).code).toBe('stale_activation');
    const afterStale = await admin.query<{ basis: number }>(
      `SELECT basis_points AS basis FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    expect(afterStale.rows[0]?.basis).toBe(10_000);
    const betaEvidence = await admin.query<{ id: string }>(
      `SELECT snapshot.id::text AS id
       FROM evidence_snapshots snapshot
       JOIN qualification_profile_versions profile ON profile.tenant_id = snapshot.tenant_id AND profile.id = snapshot.profile_version_id
       JOIN model_deployments deployment ON deployment.tenant_id = profile.tenant_id AND deployment.id = profile.candidate_deployment_id
       WHERE deployment.tenant_id = $1 AND deployment.name = 'h08g-beta'
       ORDER BY snapshot.created_at DESC LIMIT 1`,
      [other.tenantId],
    );
    const betaRollout = await activate(other, otherPolicyId, betaEvidence.rows[0]?.id ?? '');
    otherRolloutId = betaRollout.id;
    const betaCanary = await chat(other, 'qa', { task: 'coding' }, 'auto', keyFor(other, betaRollout.versionId, 5_000, 'canary'));
    const betaBase = await chat(other, 'qa', { task: 'coding' }, 'auto', keyFor(other, betaRollout.versionId, 5_000, 'baseline'));
    expect(betaCanary.headers['x-deployment']).toBe('h08g-beta');
    expect(betaBase.headers['x-deployment']).toBe('h08g-beta-base');
    const betaPromoted = await promote(other, betaRollout.id, betaRollout.epoch, 'coding');
    expect(betaPromoted.statusCode, betaPromoted.body).toBe(201);
    const pickKey = nextKey('pick');
    const selected = await chat(tenant, PROMPT, { task: 'general_qa' }, 'auto', pickKey);
    expect(selected.statusCode, selected.body).toBe(200);
    expect(selected.headers['x-deployment']).toBe('h08g-quality');
    expect((selected.json() as { model: string }).model).toBe('gpt-h08g-quality');
    const selectedDecision = await decision(tenant, String(selected.headers['x-request-id']));
    expect(selectedDecision.statusCode, selectedDecision.body).toBe(200);
    expect(selectedDecision.body).not.toContain(PROMPT);
    expect(selectedDecision.body).not.toContain(MARKER);
    expect(selectedDecision.body).not.toContain(KEY_A);
    const selectedBody = selectedDecision.json() as DecisionView;
    expect(selectedBody.routingMode).toBe('shadow');
    expect(selectedBody.selection?.reason).toBe('selected');
    expect(selectedBody.selection?.selectedDeployment).toBe('h08g-quality');
    const coding = await chat(tenant, 'qa', { task: 'coding' }, 'auto', nextKey('code'));
    expect(coding.headers['x-deployment']).toBe('h08g-base');
    const codingDecision = await decision(tenant, String(coding.headers['x-request-id']));
    expect((codingDecision.json() as DecisionView).selection?.reason).toBe('segment_mismatch');
    const betaSelected = await chat(other, 'qa', { task: 'coding' }, 'auto', nextKey('beta'));
    expect(betaSelected.headers['x-deployment']).toBe('h08g-beta');
    expect((betaSelected.json() as { model: string }).model).toBe('gpt-h08g-beta');
    const forced = await chat(tenant, 'qa', {}, 'h08g-base', nextKey('forced'));
    expect(forced.headers['x-deployment']).toBe('h08g-base');
    const forcedDecision = await decision(tenant, String(forced.headers['x-request-id']));
    const forcedBody = forcedDecision.json() as DecisionView;
    expect(forcedBody.routingMode).toBe('bypass');
    expect(forcedBody.selection).toBeNull();
    const foreignDecision = await decision(other, String(selected.headers['x-request-id']));
    expect(foreignDecision.statusCode).toBe(404);
    const foreignPolicy = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/policies/${policyId}`,
      headers: auth(other),
    });
    expect(foreignPolicy.statusCode).toBe(404);
    const mixed = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('mixed'));
    const mixedForeign = await ctx.app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: auth(tenant, undefined, undefined, other.secret),
      payload: chatPayload('auto', 'qa'),
    });
    expect(mixed.statusCode).toBe(200);
    expect(mixedForeign.statusCode).toBe(401);
    const plainPromote = await ctx.app.inject({
      method: 'POST',
      url: `/internal/v1/routing/rollouts/${rollout.id}/promote`,
      headers: auth(tenant, nextKey('plain'), undefined, plain.secret),
      payload: { expectedEpoch: created.activationEpoch, taskSegment: 'general_qa', stages: [10_000], enableSelection: true },
    });
    expect(plainPromote.statusCode).toBe(403);
    const approved = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/guardrails',
      headers: auth(tenant, nextKey('feedback-guard')),
      payload: {
        rolloutId: rollout.id,
        approvedSources: ['task-verifier'],
        rules: [{ kind: 'absolute_failure', signal: 'error_rate', threshold: 0.1, minSamples: 30, windowSeconds: 3600, maturitySeconds: 300, maxMissingFraction: 0.2, margin: 0.05 }],
      },
    });
    expect(approved.statusCode, approved.body).toBe(201);
    const feedback = await ctx.app.inject({
      method: 'POST',
      url: '/v1/feedback',
      headers: auth(tenant),
      payload: {
        requestId: String(selected.headers['x-request-id']),
        feedbackId: nextKey('fb'),
        source: 'task-verifier',
        metric: 'task_success',
        result: 'fail',
        validatorVersion: 'v1',
        timestamp: new Date().toISOString(),
      },
    });
    expect(feedback.statusCode, feedback.body).toBe(201);
    const pinned = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', pickKey);
    expect(pinned.headers['x-deployment']).toBe('h08g-quality');
    const pin = await admin.query<{ name: string }>(
      `SELECT deployment.name
       FROM routing_selection_pins pin
       JOIN model_deployments deployment ON deployment.tenant_id = pin.tenant_id AND deployment.id = pin.deployment_id
       WHERE pin.tenant_id = $1
       ORDER BY pin.created_at DESC
       LIMIT 1`,
      [tenant.tenantId],
    );
    expect(pin.rows[0]?.name).toBe('h08g-quality');
    const budgets = await admin.query<{ tenant_id: string; mode: string; monthly_amount: string }>(
      `SELECT tenant_id::text AS tenant_id, mode, monthly_amount::text AS monthly_amount
       FROM tenant_budgets WHERE tenant_id = ANY($1::uuid[])`,
      [[tenant.tenantId, other.tenantId]],
    );
    const rates = await admin.query<{ quality_min_pass_rate: string; task_segments: string[] }>(
      `SELECT quality_min_pass_rate::text AS quality_min_pass_rate, task_segments
       FROM routing_policy_versions WHERE id = ANY($1::uuid[])`,
      [[policyVersionId, otherPolicyVersionId]],
    );
    expect(new Set(budgets.rows.map((row) => row.monthly_amount)).size).toBe(2);
    expect(new Set(rates.rows.map((row) => row.quality_min_pass_rate)).size).toBe(2);
    measurements.promotion = {
      judgeRejected: errorOf(rejected.body).param,
      serving: serving.rows[0]?.count,
      activationEpoch: created.activationEpoch,
      stale: errorOf(stale.body).code,
      cohorts: cohortMap,
      forced: forced.headers['x-deployment'],
      foreignDecision: foreignDecision.statusCode,
      plainPromote: plainPromote.statusCode,
      segment: (codingDecision.json() as DecisionView).selection?.reason,
      beta: betaSelected.headers['x-deployment'],
    };
    console.log(`SECTION promotion ${JSON.stringify(measurements.promotion)}`);
  }, 180_000);

  async function countStreaming(): Promise<number> {
    const row = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_attempts
       WHERE tenant_id = $1 AND stream_status IN ('connecting', 'streaming')`,
      [tenant.tenantId],
    );
    return row.rows[0]?.count ?? 0;
  }

  async function sampleContention(work: () => Promise<void>): Promise<{
    samples: number;
    maxLocks: number;
    maxWaiting: number;
    deadlocksBefore: number;
    deadlocksAfter: number;
  }> {
    const readDeadlocks = async (): Promise<number> => {
      const row = await admin.query<{ deadlocks: number }>(
        `SELECT deadlocks::int AS deadlocks FROM pg_stat_database WHERE datname = current_database()`,
      );
      return row.rows[0]?.deadlocks ?? 0;
    };
    const deadlocksBefore = await readDeadlocks();
    const seen = { samples: 0, maxLocks: 0, maxWaiting: 0 };
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const row = await admin.query<{ locks: number; waiting: number }>(
          `SELECT count(*)::int AS locks, count(*) FILTER (WHERE NOT granted)::int AS waiting FROM pg_locks`,
        );
        seen.samples += 1;
        seen.maxLocks = Math.max(seen.maxLocks, row.rows[0]?.locks ?? 0);
        seen.maxWaiting = Math.max(seen.maxWaiting, row.rows[0]?.waiting ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    })();
    try {
      await work();
    } finally {
      sampling = false;
      await sampler;
    }
    return {
      samples: seen.samples,
      maxLocks: seen.maxLocks,
      maxWaiting: seen.maxWaiting,
      deadlocksBefore,
      deadlocksAfter: await readDeadlocks(),
    };
  }

  it('keeps one routing key on three replicas and denies a foreign read twice', async () => {
    console.log('SECTION multi-replica');
    console.log('SECTION launch');
    portA = await freePort();
    portB = await freePort();
    portC = await freePort();
    childA = spawnServer(serviceEnv(db, { ...replicaEnv(), PORT: String(portA) }));
    childB = spawnServer(serviceEnv(db, { ...replicaEnv(), PORT: String(portB) }));
    childC = spawnServer(serviceEnv(db, { ...replicaEnv(), PORT: String(portC) }));
    await waitForReady(portA);
    await waitForReady(portB);
    await waitForReady(portC);
    const routingKey = nextKey('sticky');
    const firstPass = [
      await httpChat(portA, tenant, PROMPT, { task: 'general_qa' }, 'auto', routingKey),
      await httpChat(portB, tenant, PROMPT, { task: 'general_qa' }, 'auto', routingKey),
    ];
    const foreignFirst = await httpChat(portB, tenant, 'qa', {}, 'auto', nextKey('foreign'), other.secret);
    const secondPass = [
      await httpChat(portA, tenant, PROMPT, { task: 'general_qa' }, 'auto', routingKey),
      await httpChat(portC, tenant, PROMPT, { task: 'general_qa' }, 'auto', routingKey),
    ];
    const foreignSecond = await httpChat(portC, tenant, 'qa', {}, 'auto', nextKey('foreign-2'), other.secret);
    for (const response of [...firstPass, ...secondPass]) {
      expect(response.status, response.text).toBe(200);
      expect(response.deployment).toBe('h08g-quality');
      expect(response.json().model).toBe('gpt-h08g-quality');
      expect(response.requestId).toBeTruthy();
      const stored = await decision(tenant, String(response.requestId));
      expect(stored.body).not.toContain(PROMPT);
      expect(stored.body).not.toContain(MARKER);
    }
    expect(foreignFirst.status).toBe(401);
    expect(foreignSecond.status).toBe(401);
    const logs = `${childA?.output() ?? ''}\n${childB?.output() ?? ''}\n${childC?.output() ?? ''}`;
    expect(logs).not.toContain(KEY_A);
    expect(logs).not.toContain(KEY_B);
    expect(logs).not.toContain(PROMPT);
    expect(logs).not.toContain(MARKER);
    const sampleHits = mock.hits.filter((hit) => hit.body.includes(SAMPLE)).length;
    expect(sampleHits).toBe(1);
    expect(mock.hits.some((hit) => hit.body.includes(MARKER))).toBe(false);
    const killed = childC.child.pid;
    childC.child.kill('SIGKILL');
    await waitForExit(childC.child, 5_000);
    portC = await freePort();
    childC = spawnServer(serviceEnv(db, { ...replicaEnv(), PORT: String(portC) }));
    await waitForReady(portC);
    const restarted = await httpChat(portC, tenant, 'qa', { task: 'general_qa' }, 'auto', routingKey);
    expect(restarted.status, restarted.text).toBe(200);
    expect(restarted.deployment).toBe('h08g-quality');
    const before = [childA, childB, childC].map((child) => processSample(child?.child.pid));
    const burstStarted = performance.now();
    const burst: Array<{ status: number; ms: number; requestId: string | null }> = [];
    for (let index = 0; index < 12; index += 1) {
      const port = [portA, portB, portC][index % 3] ?? portA;
      const response = await httpChat(port, tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey(`burst-${index}`));
      burst.push({ status: response.status, ms: response.ms, requestId: response.requestId });
    }
    const burstMs = performance.now() - burstStarted;
    const after = [childA, childB, childC].map((child) => processSample(child?.child.pid));
    const contention = await sampleContention(async () => {
      const overlapped = await Promise.all(
        [0, 1, 2, 3].map((index) => {
          const port = [portA, portB, portC][index % 3] ?? portA;
          return httpChat(port, tenant, 'delay', { task: 'general_qa' }, 'auto', nextKey(`overlap-${index}`));
        }),
      );
      for (const response of overlapped) {
        expect(response.status, response.text).toBe(200);
        expect(response.deployment).toBe('h08g-quality');
        expect(response.text).not.toContain(KEY_B);
        expect(response.text).not.toContain('h08g-beta');
      }
    });
    expect(contention.samples).toBeGreaterThan(0);
    const policyStarted = performance.now();
    const policyRead = await fetch(`http://127.0.0.1:${portA}/internal/v1/routing/policies/${policyId}`, {
      headers: auth(tenant),
    });
    const policyLookupMs = performance.now() - policyStarted;
    expect(policyRead.status).toBe(200);
    const rankRows = await admin.query<{ computation_ms: number; cache_hit: boolean }>(
      `SELECT computation_ms, cache_hit FROM routing_shadow_rankings
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenant.tenantId, measuredFrom],
    );
    const times = rankRows.rows.map((row) => Number(row.computation_ms));
    const cacheHits = rankRows.rows.filter((row) => row.cache_hit).length;
    const cacheDecisions = rankRows.rows.length;
    expect(cacheDecisions).toBeGreaterThan(0);
    const requestIds = burst.map((item) => item.requestId).filter((id): id is string => id !== null && id.length > 0);
    const durations = await admin.query<{ request_id: string; duration_ms: number }>(
      `SELECT request_id::text AS request_id, sum(duration_ms)::int AS duration_ms
       FROM model_attempts
       WHERE tenant_id = $1 AND request_id = ANY($2::uuid[]) AND status = 'succeeded' AND duration_ms IS NOT NULL
       GROUP BY request_id`,
      [tenant.tenantId, requestIds],
    );
    const durationByRequest = new Map(durations.rows.map((row) => [row.request_id, Number(row.duration_ms)]));
    const added = burst.flatMap((item) => {
      if (item.requestId === null) return [];
      const duration = durationByRequest.get(item.requestId);
      if (duration === undefined) return [];
      return [item.ms - duration];
    });
    expect(added.length).toBeGreaterThan(0);
    const successes = burst.filter((item) => item.status === 200).length;
    const costs = await admin.query<{ name: string; amount: string; count: number }>(
      `SELECT deployment.name, sum(cost.amount)::text AS amount, count(*)::int AS count
       FROM attempt_costs cost
       JOIN model_attempts attempt ON attempt.tenant_id = cost.tenant_id AND attempt.id = cost.attempt_id
       JOIN model_deployments deployment ON deployment.tenant_id = attempt.tenant_id AND deployment.id = attempt.deployment_id
       WHERE cost.tenant_id = $1 AND deployment.name = ANY($2::text[])
         AND cost.cost_status IN ('estimated', 'provisional', 'reconciled')
       GROUP BY deployment.name`,
      [tenant.tenantId, ['h08g-base', 'h08g-quality']],
    );
    const costByName = Object.fromEntries(costs.rows.map((row) => [row.name, { amount: row.amount, count: row.count }]));
    const qualityAmount = Number(costByName['h08g-quality']?.amount ?? 0);
    const qualityCount = Number(costByName['h08g-quality']?.count ?? 0);
    const baseAmount = Number(costByName['h08g-base']?.amount ?? 0);
    const baseCount = Number(costByName['h08g-base']?.count ?? 0);
    const qualityUnit = qualityCount === 0 ? null : qualityAmount / qualityCount;
    const baseUnit = baseCount === 0 ? null : baseAmount / baseCount;
    const realized = qualityUnit === null || baseUnit === null ? null : baseUnit - qualityUnit;
    measurements.replicas = {
      deployment: firstPass.map((item) => item.deployment),
      repeated: secondPass.map((item) => item.deployment),
      foreign: [foreignFirst.status, foreignSecond.status],
      restartedPid: killed,
      restartedDeployment: restarted.deployment,
    };
    measurements.performance = {
      routingCpuSeconds: after.reduce((sum, item, index) => sum + (item.cpuSeconds - (before[index]?.cpuSeconds ?? 0)), 0),
      routingCpuLabel: measurements.labels,
      rssKb: after.map((item) => item.rssKb),
      computationMs: { p50: percentile(times, 50), p95: percentile(times, 95), p99: percentile(times, 99), samples: times.length },
      clientChatMs: { p50: percentile(burst.map((item) => item.ms), 50), samples: burst.length },
      addedInferenceLatencyMs: { p50: percentile(added, 50), p95: percentile(added, 95), samples: added.length },
      evidenceCacheHits: cacheHits,
      evidenceCacheDecisions: cacheDecisions,
      evidenceCacheHitRate: cacheHits / cacheDecisions,
      policyLookupMs,
      locksNotGranted: contention.maxWaiting,
      lockSamples: contention.samples,
      maxLocks: contention.maxLocks,
      deadlocksBefore: contention.deadlocksBefore,
      deadlocksAfter: contention.deadlocksAfter,
      throughputPerSecond: burst.length / (burstMs / 1000),
      successRate: successes / burst.length,
      costByDeployment: costByName,
      realizedSavingsPerSuccess: realized,
      realizedSavingsLabel: 'difference of stored attempt_costs unit amounts for h08g-base and h08g-quality',
      predictedSavingsLabel: 'not realized',
    };
    console.log(`SECTION launch ${JSON.stringify(measurements.replicas)}`);
    console.log(`SECTION performance ${JSON.stringify(measurements.performance)}`);
    console.log('LAUNCH model=gpt-h08g-quality decision-has-prompt=false');
    console.log('LAUNCH repeat model=gpt-h08g-quality decision-has-prompt=false');
  }, 180_000);

  function hitsFor(content: string): number {
    return mock.hits.filter((hit) => hit.body.includes(content)).length;
  }

  async function databaseAcceptsConnections(): Promise<boolean> {
    const Pg = (await import('pg')).default;
    const client = new Pg.Client({
      host: db.host,
      port: db.port,
      database: db.database,
      user: db.username,
      password: db.password,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
    });
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('SELECT 1');
      return true;
    } catch {
      return false;
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async function servingEpoch(): Promise<number> {
    const row = await admin.query<{ epoch: number }>(
      `SELECT activation_epoch::int AS epoch FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    const epoch = row.rows[0]?.epoch;
    if (epoch === undefined) throw new Error('serving promotion is missing');
    return epoch;
  }

  function fallback(enabled: boolean, regions: string[] = []): void {
    const args = [
      'set-fallback-policy', '--tenant-id', tenant.tenantId, '--alias', 'auto',
      '--enabled', enabled ? 'true' : 'false',
      '--deployments', 'h08g-base', '--failures', 'unavailable', '--max-attempts', '2',
      '--capabilities', 'temperature', '--providers', 'openai', '--data-collection', 'allow',
      '--min-remaining-deadline-ms', '0',
    ];
    if (regions.length > 0) args.push('--regions', regions.join(','));
    cli(args);
  }

  function limits(mode: 'hard' | 'observe', concurrent: string): void {
    cli([
      'set-tenant-limits', '--tenant-id', tenant.tenantId, '--mode', mode,
      '--requests-per-minute', '100000', '--concurrent-requests', concurrent,
      '--concurrent-streams', '4', '--token-rate', '1000000', '--lease-ms', '60000',
    ]);
  }

  it('keeps execution controls on the shipped chat path', async () => {
    console.log('SECTION failure-injection');
    const streamed = await chat(tenant, 'stream', { stream: true }, 'auto', nextKey('stream'));
    expect(streamed.statusCode, streamed.body).toBe(200);
    expect(streamed.body).toContain('data: [DONE]');
    const partial = await chat(tenant, 'partial', { stream: true }, 'auto', nextKey('partial'));
    expect(partial.body.includes('data: [DONE]')).toBe(false);
    expect(hitsFor('partial')).toBe(1);
    const partialRow = await latestRequest(tenant.tenantId);
    expect(partialRow.failure_class).toBe('stream_started');
    expect(partialRow.status).toBe('failed');
    cli([
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'h08g-poor',
      '--retries', 'false', '--connection-deadline-ms', '200', '--attempt-deadline-ms', '200',
      '--total-deadline-ms', '200', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    const beforeDelay = hitsFor('delay');
    const timed = await chat(tenant, 'delay', {}, 'h08g-poor', nextKey('timeout'));
    expect(timed.statusCode, timed.body).toBe(504);
    expect(errorOf(timed.body).code).toBe('timeout');
    expect(hitsFor('delay') - beforeDelay).toBe(1);
    expect(timed.headers['x-deployment']).toBe('h08g-poor');
    cli([
      'set-execution-policy', '--tenant-id', tenant.tenantId, '--deployment', 'h08g-poor',
      '--retries', 'false', '--connection-deadline-ms', '5000', '--attempt-deadline-ms', '5000',
      '--total-deadline-ms', '5000', '--initial-backoff-ms', '0', '--max-backoff-ms', '0',
    ]);
    const beforeDown = hitsFor('down');
    const outage = await chat(tenant, 'down', {}, 'h08g-poor', nextKey('outage'));
    expect(outage.statusCode).not.toBe(200);
    expect(hitsFor('down') - beforeDown).toBe(1);
    expect(outage.headers['x-deployment']).toBe('h08g-poor');
    const outageAttempts = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_attempts WHERE tenant_id = $1 AND request_id = $2`,
      [tenant.tenantId, String(outage.headers['x-request-id'])],
    );
    expect(outageAttempts.rows[0]?.count).toBe(1);
    cli([
      'set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', 'h08g-poor',
      '--enabled', 'true', '--window-ms', '60000', '--min-samples', '1', '--failure-threshold', '1',
      '--cooldown-ms', '60000', '--max-probes', '1',
    ]);
    const opened = await chat(tenant, 'down', {}, 'h08g-poor', nextKey('open-breaker'));
    expect(opened.statusCode).not.toBe(200);
    const blockedHits = mock.hits.length;
    const blocked = await chat(tenant, 'down', {}, 'h08g-poor', nextKey('circuit'));
    expect(blocked.statusCode).toBe(503);
    expect(errorOf(blocked.body).code).toBe('circuit_open');
    expect(mock.hits.length).toBe(blockedHits);
    cli(['reset-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', 'h08g-poor']);
    cli(['set-deployment-breaker', '--tenant-id', tenant.tenantId, '--deployment', 'h08g-poor', '--enabled', 'false']);
    cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'hard', '--monthly-amount', '0']);
    try {
      const denied = await chat(tenant, 'budget-pressure', {}, 'auto', nextKey('budget'));
      const otherOk = await chat(other, 'qa', { task: 'coding' }, 'auto', nextKey('budget-other'));
      expect(denied.statusCode, denied.body).toBe(429);
      expect(errorOf(denied.body).code).toBe('budget_exceeded');
      expect(hitsFor('budget-pressure')).toBe(0);
      expect(otherOk.statusCode, otherOk.body).toBe(200);
      expect(otherOk.headers['x-deployment']).toBe('h08g-beta');
      expect(denied.body).not.toContain(other.secret);
    } finally {
      cli(['set-tenant-budget', '--tenant-id', tenant.tenantId, '--mode', 'observe', '--monthly-amount', '5']);
    }
    limits('hard', '1');
    try {
      const pair = await Promise.all([
        chat(tenant, 'delay', {}, 'auto', nextKey('lease-a')),
        chat(tenant, 'delay', {}, 'auto', nextKey('lease-b')),
      ]);
      expect(pair.map((item) => item.statusCode).sort()).toEqual([200, 429]);
      const limited = pair.find((item) => item.statusCode === 429);
      expect(errorOf(limited?.body ?? '{}').code).toBe('concurrency_limited');
    } finally {
      limits('observe', '100');
    }
    fallback(true);
    const fell = await chat(tenant, 'fall', { task: 'general_qa' }, 'auto', nextKey('fall'));
    expect(fell.statusCode, fell.body).toBe(200);
    expect(fell.headers['x-deployment']).toBe('h08g-base');
    expect(fell.headers['x-fallback']).toBe('true');
    const forcedDown = await chat(tenant, 'forced-down', {}, 'h08g-poor', nextKey('forced-down'));
    expect(forcedDown.statusCode).not.toBe(200);
    expect(forcedDown.headers['x-deployment']).toBe('h08g-poor');
    const forcedAttempts = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM model_attempts WHERE tenant_id = $1 AND request_id = $2`,
      [tenant.tenantId, String(forcedDown.headers['x-request-id'])],
    );
    expect(forcedAttempts.rows[0]?.count).toBe(1);
    fallback(false);
    const pending = openPost(portA, tenant.tenantId, tenant.secret, chatPayload('auto', 'cancel', { stream: true }));
    await waitFor(async () => {
      const row = await latestRequest(tenant.tenantId);
      return row.stream_status === 'streaming' || row.stream_status === 'connecting';
    }, 'cancel started');
    pending.destroy();
    const cancelled = await pending.settled;
    expect(cancelled.raw.includes('[DONE]')).toBe(false);
    await waitFor(async () => {
      const row = await latestRequest(tenant.tenantId);
      return row.stream_status === 'client_aborted';
    }, 'cancel stored');
    const heldStream = openPost(portA, tenant.tenantId, tenant.secret, chatPayload('auto', 'hold', { stream: true }));
    await waitFor(async () => held.length > 0, 'held stream');
    const second = await httpChat(portA, tenant, 'qa', { stream: true }, 'auto', nextKey('capacity'));
    expect(second.status).toBe(503);
    expect(errorOf(second.text).code).toBe('stream_capacity');
    const activeDuring = await countStreaming();
    expect(activeDuring).toBeGreaterThan(0);
    heldStream.destroy();
    releaseHeld();
    await waitFor(async () => (await countStreaming()) === 0, 'held stream released', 10_000);
    const activeAfter = await countStreaming();
    expect(activeAfter).toBe(0);
    let revoked = false;
    let budgetReadStatus = 0;
    let budgetReadCode = '';
    try {
      await admin.query(`REVOKE EXECUTE ON FUNCTION ${admitFunction} FROM llm_runtime`);
      revoked = true;
      const blockedBudget = await chat(tenant, 'budget-read', { task: 'general_qa' }, 'auto', nextKey('budget-read'));
      budgetReadStatus = blockedBudget.statusCode;
      budgetReadCode = errorOf(blockedBudget.body).code;
      expect(budgetReadStatus, blockedBudget.body).toBe(503);
      expect(budgetReadCode).toBe('admission_unavailable');
      expect(hitsFor('budget-read')).toBe(0);
      expect(blockedBudget.body).not.toContain(other.secret);
      expect(blockedBudget.body).not.toContain(KEY_B);
      expect(blockedBudget.body).not.toContain('h08g-beta');
      expect(blockedBudget.body).not.toContain('gpt-h08g-beta');
    } finally {
      if (revoked) await admin.query(`GRANT EXECUTE ON FUNCTION ${admitFunction} TO llm_runtime`);
    }
    const budgetRestored = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('budget-restored'));
    expect(budgetRestored.statusCode, budgetRestored.body).toBe(200);
    expect(budgetRestored.headers['x-deployment']).toBe('h08g-quality');
    await insertSnapshot(tenant, qualityProfile, 'quality-invalid-live', qualityRun, 'unqualified', ['objective_threshold_failed'], 0.1);
    const invalid = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('invalid-evidence'));
    expect(invalid.statusCode, invalid.body).toBe(200);
    expect(invalid.headers['x-deployment']).not.toBe('h08g-quality');
    expect(['h08g-base', 'h08g-tie']).toContain(invalid.headers['x-deployment']);
    expect(invalid.body).not.toContain('h08g-beta');
    await insertSnapshot(tenant, qualityProfile, 'quality-valid-again', qualityRun, 'qualified', [], 0.95);
    resetShadowRankCache();
    const validAgain = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('valid-again'));
    expect(validAgain.headers['x-deployment']).toBe('h08g-quality');
    const epochBeforeStale = await servingEpoch();
    const staleAgain = await promote(tenant, rolloutId, rolloutEpoch, 'general_qa');
    expect(staleAgain.statusCode, staleAgain.body).toBe(409);
    expect(errorOf(staleAgain.body).code).toBe('stale_activation');
    expect(await servingEpoch()).toBe(epochBeforeStale);
    const servingBeforeCrash = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    const crashed = spawn(process.execPath, [join(projectRoot, 'dist', 'promotion-worker.js')], {
      cwd: projectRoot,
      env: serviceEnv(db, { PROMOTION_TENANTS: tenant.tenantId, PROMOTION_INTERVAL_MS: '100' }),
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    crashed.kill('SIGKILL');
    await waitForExit(crashed, 5_000);
    const servingAfterCrash = await admin.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    expect(servingAfterCrash.rows[0]?.count).toBe(servingBeforeCrash.rows[0]?.count);
    const afterCrash = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('after-crash'));
    expect(afterCrash.statusCode, afterCrash.body).toBe(200);
    expect(afterCrash.headers['x-deployment']).toBe('h08g-quality');
    let concurrentDeployment = '';
    try {
      const raced = await Promise.all([
        admin.query(`UPDATE model_deployments SET enabled = false WHERE tenant_id = $1 AND name = 'h08g-quality'`, [tenant.tenantId]),
        chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('concurrent-deploy')),
      ]);
      const racedChat = raced[1];
      expect(racedChat.statusCode, racedChat.body).toBe(200);
      concurrentDeployment = String(racedChat.headers['x-deployment'] ?? '');
      expect(['h08g-quality', 'h08g-tie', 'h08g-base']).toContain(concurrentDeployment);
      expect(racedChat.body).not.toContain('h08g-beta');
      expect(racedChat.body).not.toContain(KEY_B);
      expect(racedChat.body).not.toContain(other.secret);
    } finally {
      await restoreQuality();
    }
    let lostDeployment = '';
    try {
      cli(['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'h08g-quality', '--enabled', 'false']);
      await admin.query(
        `UPDATE model_deployments SET validation_status = 'unvalidated' WHERE tenant_id = $1 AND name = 'h08g-tie'`,
        [tenant.tenantId],
      );
      const lost = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('lost-permission'));
      expect(lost.statusCode, lost.body).toBe(200);
      lostDeployment = String(lost.headers['x-deployment'] ?? '');
      expect(lostDeployment).toBe('h08g-base');
      expect(lost.body).not.toContain('h08g-quality');
      expect(lost.body).not.toContain('h08g-beta');
      expect(lost.body).not.toContain(KEY_B);
    } finally {
      await restoreQuality();
    }
    const beforeOutage = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('before-outage'));
    expect(beforeOutage.statusCode, beforeOutage.body).toBe(200);
    expect(beforeOutage.headers['x-deployment']).toBe('h08g-quality');
    if (!/^[A-Za-z0-9_]+$/.test(db.database)) throw new Error('database name is invalid');
    const Pg = (await import('pg')).default;
    const control = new Pg.Client({
      host: db.host,
      port: db.port,
      database: 'postgres',
      user: db.username,
      password: db.password,
      connectionTimeoutMillis: 5_000,
    });
    control.on('error', () => undefined);
    await control.connect();
    let closed = false;
    let down: Awaited<ReturnType<typeof chat>> | undefined;
    let restoredOther: Awaited<ReturnType<typeof chat>> | undefined;
    try {
      await control.query(`ALTER DATABASE ${db.database} ALLOW_CONNECTIONS false`);
      await control.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [db.database],
      );
      closed = true;
      await waitFor(async () => {
        const ready = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
        return ready.statusCode === 503 && ready.body.includes('"database":"unavailable"');
      }, 'runtime database stopped', 20_000);
      down = await chat(tenant, 'db-down', { task: 'general_qa' }, 'auto', nextKey('db-down'));
      expect(down.statusCode).not.toBe(200);
      expect([500, 503]).toContain(down.statusCode);
      expect(hitsFor('db-down')).toBe(0);
      expect(down.headers['x-deployment'] ?? '').toBe('');
      expect(down.body).not.toContain(other.secret);
      expect(down.body).not.toContain(tenant.secret);
      expect(down.body).not.toContain(KEY_A);
      expect(down.body).not.toContain(KEY_B);
      expect(down.body).not.toContain('h08g-beta');
      expect(down.body).not.toContain('gpt-h08g-beta');
    } finally {
      if (closed) {
        try {
          await control.query(`ALTER DATABASE ${db.database} ALLOW_CONNECTIONS true`);
        } catch {
          const again = new Pg.Client({
            host: db.host,
            port: db.port,
            database: 'postgres',
            user: db.username,
            password: db.password,
            connectionTimeoutMillis: 5_000,
          });
          again.on('error', () => undefined);
          await again.connect();
          await again.query(`ALTER DATABASE ${db.database} ALLOW_CONNECTIONS true`);
          await again.end();
        }
      }
      await control.end().catch(() => undefined);
      await waitFor(async () => {
        if (!(await databaseAcceptsConnections())) return false;
        try {
          await admin.query('SELECT 1');
        } catch {
          return false;
        }
        const ready = await ctx.app.inject({ method: 'GET', url: '/health/ready' });
        if (ready.statusCode !== 200) return false;
        const probe = await chat(other, 'qa', { task: 'coding' }, 'auto', nextKey('db-restored'));
        if (probe.statusCode !== 200 || probe.headers['x-deployment'] !== 'h08g-beta') return false;
        restoredOther = probe;
        return true;
      }, 'runtime database restored', 30_000);
    }
    if (down === undefined || restoredOther === undefined) throw new Error('database outage chat did not run');
    expect(restoredOther.headers['x-deployment']).toBe('h08g-beta');
    expect(restoredOther.body).toContain('gpt-h08g-beta');
    expect(restoredOther.body).not.toContain(KEY_A);
    expect(restoredOther.body).not.toContain(tenant.secret);
    expect(restoredOther.body).not.toContain('h08g-quality');
    expect(restoredOther.body).not.toContain('h08g-base');
    const afterOutage = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('after-outage'));
    expect(afterOutage.statusCode, afterOutage.body).toBe(200);
    expect(afterOutage.headers['x-deployment']).toBe('h08g-quality');
    const outageCode = errorOf(down.body).code;
    console.log(
      `DATABASE_OUTAGE ready=503 status=${down.statusCode} code=${outageCode} hits=0 deployment= restored=${restoredOther.headers['x-deployment']}`,
    );
    measurements.execution = {
      partialStatus: partialRow.status,
      timeout: timed.statusCode,
      outageAttempts: outageAttempts.rows[0]?.count,
      circuit: errorOf(blocked.body).code,
      budget: 'budget_exceeded',
      fallback: fell.headers['x-deployment'],
      forced: forcedDown.headers['x-deployment'],
      streamCapacity: second.status,
      activeStreams: activeDuring,
      activeStreamsAfter: activeAfter,
      budgetReadStatus,
      budgetReadCode,
      budgetReadHits: 0,
      invalidEvidenceDeployment: invalid.headers['x-deployment'],
      staleActivation: errorOf(staleAgain.body).code,
      workerCrashDeployment: afterCrash.headers['x-deployment'],
      workerCrashServing: servingAfterCrash.rows[0]?.count,
      concurrentDeployment,
      lostPermissionDeployment: lostDeployment,
      databaseOutageStatus: down.statusCode,
      databaseOutageCode: outageCode,
      databaseOutageHits: 0,
      databaseOutageRestored: restoredOther.headers['x-deployment'],
    };
    if (measurements.performance !== undefined && typeof measurements.performance === 'object') {
      Object.assign(measurements.performance, { activeStreams: activeDuring, activeStreamsAfter: activeAfter });
    }
    console.log(`SECTION failure-injection ${JSON.stringify(measurements.execution)}`);
  }, 240_000);

  it('blocks a drifted model, a foreign row, and a rewritten audit row', async () => {
    console.log('SECTION security');
    const epoch = await servingEpoch();
    await admin.query(
      `UPDATE model_deployments SET upstream_model = 'gpt-h08g-quality-drift' WHERE tenant_id = $1 AND name = 'h08g-quality'`,
      [tenant.tenantId],
    );
    try {
      const drifted = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('model-drift'));
      expect(drifted.statusCode, drifted.body).toBe(200);
      expect(drifted.headers['x-deployment']).toBe('h08g-base');
      const driftedDecision = await decision(tenant, String(drifted.headers['x-request-id']));
      expect((driftedDecision.json() as DecisionView).selection?.reason).toBe('baseline_fallback');
      const ranked = await simulate(tenant);
      expect(ranked.recommendedDeployment).toBe('h08g-quality');
      const gated = await promote(tenant, rolloutId, epoch, 'general_qa');
      expect(gated.statusCode, gated.body).toBe(409);
      expect(errorOf(gated.body).param).toBe('fresh_model_version');
    } finally {
      await restoreQuality();
    }
    const restoredModel = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('model-back'));
    expect(restoredModel.headers['x-deployment']).toBe('h08g-quality');
    await admin.query(
      `UPDATE model_deployments SET config_version = config_version + 1 WHERE tenant_id = $1 AND name = 'h08g-quality'`,
      [tenant.tenantId],
    );
    try {
      const configEpoch = await servingEpoch();
      const drifted = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('config-drift'));
      expect(drifted.headers['x-deployment']).toBe('h08g-base');
      const gated = await promote(tenant, rolloutId, configEpoch, 'general_qa');
      expect(gated.statusCode, gated.body).toBe(409);
      expect(errorOf(gated.body).param).toBe('fresh_config_version');
    } finally {
      await restoreQuality();
    }
    const liveQuality = await admin.query<{ config_version: number; upstream_model: string }>(
      `SELECT config_version, upstream_model FROM model_deployments WHERE tenant_id = $1 AND name = 'h08g-quality'`,
      [tenant.tenantId],
    );
    const ageProfile = await qualify(
      tenant,
      'qp-h08g-quality-age',
      'h08g-quality',
      liveQuality.rows[0]?.upstream_model ?? 'gpt-h08g-quality',
      Number(liveQuality.rows[0]?.config_version ?? 0),
      'general_qa',
      outputA,
      1,
    );
    await insertSnapshot(tenant, ageProfile, 'quality-age', qualityRun, 'qualified', [], 0.95);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    resetShadowRankCache();
    const agedRank = await simulate(tenant);
    expect(agedRank.recommendedDeployment).not.toBe('h08g-quality');
    expect(agedRank.exclusions.find((item) => item.deployment === 'h08g-quality')?.reason).toBe('evidence_stale');
    const aged = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('aged'));
    expect(aged.headers['x-deployment']).not.toBe('h08g-quality');
    await insertSnapshot(tenant, qualityProfile, 'quality-fresh', qualityRun, 'qualified', [], 0.95);
    resetShadowRankCache();
    const fresh = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('fresh'));
    expect(fresh.headers['x-deployment']).toBe('h08g-quality');
    await insertSnapshot(tenant, qualityProfile, 'quality-regressed', qualityRun, 'unqualified', ['objective_threshold_failed'], 0.1);
    const regressed = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('regressed'));
    expect(regressed.headers['x-deployment']).not.toBe('h08g-quality');
    await insertSnapshot(tenant, qualityProfile, 'quality-clear', qualityRun, 'qualified', [], 0.95);
    resetShadowRankCache();
    cli([
      'register-deployment', '--tenant-id', tenant.tenantId, '--name', 'h08g-extra',
      '--upstream-model', 'gpt-h08g-extra', '--timeout-ms', '5000', '--capabilities', 'temperature', '--enabled', 'true',
    ]);
    cli(['register-price', '--provider', 'openai', '--upstream-model', 'gpt-h08g-extra', '--effective-at', EFFECTIVE, '--source', 'fixture', '--status', 'verified', '--input-rate', '0.030000']);
    const extraVersion = await admin.query<{ config_version: number }>(
      `SELECT config_version FROM model_deployments WHERE tenant_id = $1 AND name = 'h08g-extra'`,
      [tenant.tenantId],
    );
    const extraProfile = await qualify(
      tenant, 'qp-h08g-extra', 'h08g-extra', 'gpt-h08g-extra',
      Number(extraVersion.rows[0]?.config_version ?? 0), 'general_qa', outputA,
    );
    const refreshed = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/evidence/refresh',
      headers: auth(tenant, nextKey('refresh')),
      payload: { profileVersionId: extraProfile },
    });
    expect(refreshed.statusCode, refreshed.body).toBe(201);
    const servingVersion = await admin.query<{ id: string }>(
      `SELECT policy_version_id::text AS id FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
      [tenant.tenantId],
    );
    expect(servingVersion.rows[0]?.id).toBe(policyVersionId);
    const still = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('still'));
    expect(still.headers['x-deployment']).toBe('h08g-quality');
    try {
      cli(['set-deployment-enabled', '--tenant-id', tenant.tenantId, '--name', 'h08g-quality', '--enabled', 'false']);
      await admin.query(
        `UPDATE model_deployments SET validation_status = 'unvalidated' WHERE tenant_id = $1 AND name = 'h08g-tie'`,
        [tenant.tenantId],
      );
      const lost = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('lost'));
      expect(lost.headers['x-deployment']).not.toBe('h08g-quality');
      expect(lost.headers['x-deployment']).toBe('h08g-base');
    } finally {
      await restoreQuality();
    }
    fallback(true, ['europe-west1']);
    try {
      await admin.query(
        `UPDATE model_deployments SET validation_status = 'unvalidated' WHERE tenant_id = $1 AND name = ANY($2::text[])`,
        [tenant.tenantId, ['h08g-quality', 'h08g-tie']],
      );
      const before = hitsFor('residency');
      const blocked = await chat(tenant, 'residency', { task: 'general_qa' }, 'auto', nextKey('region'));
      expect(blocked.statusCode, blocked.body).toBe(409);
      expect(errorOf(blocked.body).code).toBe('baseline_unavailable');
      expect(hitsFor('residency')).toBe(before);
    } finally {
      await restoreQuality();
      fallback(false);
    }
    const runtime = createPool(configFor(db), 'runtime');
    try {
      const seen = await withTenant(runtime, tenant.tenantId, (client) => client.query<{ foreign: number; own: number }>(
        `SELECT count(*) FILTER (WHERE tenant_id = $1)::int AS foreign, count(*)::int AS own FROM routing_promotions`,
        [other.tenantId],
      ));
      expect(seen.rows[0]?.foreign).toBe(0);
      expect(seen.rows[0]?.own).toBeGreaterThan(0);
    } finally {
      await runtime.end();
    }
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const foreignDeployment = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM model_deployments WHERE tenant_id = $1 AND name = 'h08g-beta'`,
        [other.tenantId],
      );
      const promotion = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM routing_promotions WHERE tenant_id = $1 AND status = 'serving'`,
        [tenant.tenantId],
      );
      await expect(client.query(
        `INSERT INTO routing_selection_pins (tenant_id, promotion_id, routing_key_digest, deployment_id)
         VALUES ($1, $2, $3, $4)`,
        [tenant.tenantId, promotion.rows[0]?.id, 'ab'.repeat(32), foreignDeployment.rows[0]?.id],
      )).rejects.toThrow(/foreign key/i);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    async function expectRaise(sql: string, params: unknown[], message: RegExp): Promise<void> {
      const audit = await admin.connect();
      try {
        await audit.query('BEGIN');
        await expect(audit.query(sql, params)).rejects.toThrow(message);
      } finally {
        await audit.query('ROLLBACK');
        audit.release();
      }
    }
    await expectRaise(`UPDATE routing_promotion_events SET actor = actor WHERE tenant_id = $1`, [tenant.tenantId], /promotion event is immutable/);
    await expectRaise(`DELETE FROM routing_selection_decisions WHERE tenant_id = $1`, [tenant.tenantId], /selection decision is immutable/);
    await expectRaise(`UPDATE routing_selection_pins SET deployment_id = deployment_id WHERE tenant_id = $1`, [tenant.tenantId], /selection pin is immutable/);
    await expectRaise(`DELETE FROM routing_promotions WHERE tenant_id = $1`, [tenant.tenantId], /promotion identity is immutable/);
    const applied = await admin.query<{ version: string }>(`SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`);
    const latest = await latestMigrationVersion();
    expect(applied.rows[0]?.version).toBe(latest);
    expect(latest).toBe('031_routing_promotions.sql');
    const docker = readFileSync(join(projectRoot, 'Dockerfile'), 'utf8');
    const entry = readFileSync(join(projectRoot, 'src', 'index.ts'), 'utf8');
    expect(docker).toContain('CMD ["node", "dist/index.js"]');
    expect(docker).not.toContain('guardrail-worker');
    expect(docker).not.toContain('promotion-worker');
    expect(entry).not.toContain('guardrail-worker');
    expect(entry).not.toContain('promotion-worker');
    const back = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('secure-back'));
    expect(back.headers['x-deployment']).toBe('h08g-quality');
    measurements.security = {
      modelDrift: 'baseline_fallback',
      configDrift: 'fresh_config_version',
      aged: aged.headers['x-deployment'],
      agedReason: 'evidence_stale',
      regressed: regressed.headers['x-deployment'],
      refresh: refreshed.statusCode,
      residency: 'baseline_unavailable',
      foreignPromotions: 0,
      migration: applied.rows[0]?.version,
    };
    console.log(`SECTION security ${JSON.stringify(measurements.security)}`);
  }, 180_000);

  it('rolls back to the stored baseline after the controller stops', async () => {
    const idleGuard = spawn(process.execPath, [join(projectRoot, 'dist', 'guardrail-worker.js')], {
      cwd: projectRoot,
      env: serviceEnv(db, { GUARDRAIL_TENANTS: '' }),
      stdio: 'ignore',
    });
    expect(await waitForExit(idleGuard, 20_000)).toBe(0);
    const idlePromotion = spawn(process.execPath, [join(projectRoot, 'dist', 'promotion-worker.js')], {
      cwd: projectRoot,
      env: serviceEnv(db, { PROMOTION_TENANTS: '' }),
      stdio: 'ignore',
    });
    expect(await waitForExit(idlePromotion, 20_000)).toBe(0);
    const crashed = spawn(process.execPath, [join(projectRoot, 'dist', 'promotion-worker.js')], {
      cwd: projectRoot,
      env: serviceEnv(db, { PROMOTION_TENANTS: tenant.tenantId, PROMOTION_INTERVAL_MS: '100' }),
      stdio: 'ignore',
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    crashed.kill('SIGKILL');
    await waitForExit(crashed, 5_000);
    const current = await ctx.app.inject({
      method: 'GET',
      url: `/internal/v1/routing/rollouts/${rolloutId}`,
      headers: auth(tenant),
    });
    expect(current.statusCode, current.body).toBe(200);
    const epoch = (current.json() as { epoch: number }).epoch;
    const started = performance.now();
    const raced = await Promise.all([
      ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/rollouts/${rolloutId}/rollback`,
        headers: auth(tenant, nextKey('self-promote')),
        payload: { expectedEpoch: epoch, promote: true },
      }),
      ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/rollouts/${rolloutId}/rollback`,
        headers: auth(tenant, nextKey('rollback-a')),
        payload: { expectedEpoch: epoch },
      }),
      ctx.app.inject({
        method: 'POST',
        url: `/internal/v1/routing/rollouts/${rolloutId}/rollback`,
        headers: auth(tenant, nextKey('rollback-b')),
        payload: { expectedEpoch: epoch },
      }),
    ]);
    expect(raced[0]?.statusCode).toBe(400);
    expect(errorOf(raced[0]?.body ?? '{}').code).toBe('promotion_rejected');
    expect(raced.slice(1).map((item) => item.statusCode).sort()).toEqual([200, 409]);
    const seen = await admin.query<{ status: string }>(`SELECT status FROM routing_rollouts WHERE id = $1`, [rolloutId]);
    const propagationMs = performance.now() - started;
    expect(seen.rows[0]?.status).toBe('stopped');
    for (const port of [portA, portB]) {
      const first = await httpChat(port, tenant, 'qa', {}, 'auto', nextKey('restored'));
      const second = await httpChat(port, tenant, 'qa', {}, 'auto', nextKey('restored'));
      expect(first.status, first.text).toBe(200);
      expect(second.status, second.text).toBe(200);
      expect(first.deployment).toBe('h08g-base');
      expect(second.deployment).toBe('h08g-base');
    }
    const forced = await httpChat(portA, tenant, 'qa', {}, 'h08g-poor');
    expect(forced.status, forced.text).toBe(200);
    expect(forced.deployment).toBe('h08g-poor');
    const evidence = await admin.query<{ id: string }>(
      `SELECT id::text AS id FROM evidence_snapshots WHERE profile_version_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [qualityProfile],
    );
    const guardRollout = await activate(tenant, policyId, evidence.rows[0]?.id ?? '', 10_000);
    const attached = await ctx.app.inject({
      method: 'POST',
      url: '/internal/v1/routing/guardrails',
      headers: auth(tenant, nextKey('guard')),
      payload: {
        rolloutId: guardRollout.id,
        approvedSources: ['task-verifier'],
        rules: [{ kind: 'absolute_failure', signal: 'error_rate', threshold: 0.1, minSamples: 1, windowSeconds: 3600, maturitySeconds: 0, maxMissingFraction: 1, margin: 0 }],
      },
    });
    expect(attached.statusCode, attached.body).toBe(201);
    const failed = await chat(tenant, 'down', {}, 'auto', nextKey('guard-fail'));
    expect(failed.statusCode).not.toBe(200);
    expect(failed.headers['x-deployment']).toBe('h08g-quality');
    const report = await runGuardrailPass(ctx.runtimePool, [tenant.tenantId]);
    expect(report.stops).toBeGreaterThan(0);
    const stopped = await chat(tenant, 'qa', { task: 'general_qa' }, 'auto', nextKey('guard-after'));
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(stopped.headers['x-deployment']).toBe('h08g-base');
    const foreignGuards = await ctx.app.inject({
      method: 'GET',
      url: '/internal/v1/routing/guardrails',
      headers: auth(other),
    });
    expect(foreignGuards.statusCode).toBe(200);
    expect((foreignGuards.json() as { guardrails: unknown[] }).guardrails).toEqual([]);
    measurements.recovery = {
      propagationMs,
      rollbackStatuses: raced.map((item) => item.statusCode),
      restoredDeployment: 'h08g-base',
      forcedDeployment: forced.deployment,
      detectionMs: report.detectionMs,
      rollbackMs: report.rollbackMs,
      stops: report.stops,
      guardAfter: stopped.headers['x-deployment'],
    };
    console.log(`SECTION recovery ${JSON.stringify(measurements.recovery)}`);
  }, 180_000);
});

describe('routing hardening providers', () => {
  const db = loadTestDatabase();
  const names = defaultNames('h08gmx');
  const email = 'h08g-matrix@h08g-vertex-proj.iam.gserviceaccount.com';
  const keys = {
    openai: 'sk-h08g-matrix-openai',
    anthropic: 'sk-ant-h08g-matrix',
    vertexEmail: email,
    vertexKey: vertexKey(email),
    vertexProject: 'h08g-vertex-proj',
    xai: 'xai-h08g-matrix-key1',
    openrouter: 'or-h08g-matrix-key1',
    dgx: 'dgx-h08g-matrix-key1',
  };
  const tenant = { tenantId: '', secret: '' };
  let doubles: Doubles;
  let port = 0;
  let closeApp: () => Promise<void> = async () => undefined;
  let admin: pg.Pool;
  const proof: unknown[] = [];

  beforeAll(async () => {
    doubles = await startDoubles();
    const created = provisionTenant(db, 'Harden Matrix');
    tenant.tenantId = created.tenantId;
    tenant.secret = created.secret;
    registerSix(db, tenant.tenantId, names, keys, doubles.anthropicOrigin);
    const listened = await listenProxy(db, doubles);
    port = listened.port;
    closeApp = listened.close;
    admin = openDb(db);
  }, 180_000);

  afterAll(async () => {
    mkdirSync(EVIDENCE, { recursive: true });
    const path = join(EVIDENCE, 'measurements.json');
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      current = {};
    }
    current.providers = proof;
    writeFileSync(path, `${JSON.stringify(current, null, 2)}\n`);
    await closeApp();
    await admin.end();
    await doubles.close();
  });

  it('exercises every provider on the shipped adapters and keeps DGX on the mock host', async () => {
    const providers = Object.keys(UPSTREAM) as ProviderName[];
    for (const provider of providers) {
      const before = snapshot(doubles);
      const response = await matrixChat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'ok') }],
      });
      expect(response.status, provider).toBe(200);
      expect(grewOnly(before, snapshot(doubles), provider), provider).toBe(true);
      const stored = await latestAttempt(admin, tenant.tenantId);
      expect(stored.provider).toBe(provider);
      expect(stored.deployment_name).toBe(names[provider]);
      expect(stored.upstream_model).toBe(UPSTREAM[provider]);
      expect(stored.status).toBe('succeeded');
      const streamBefore = snapshot(doubles);
      const streamed = await matrixChat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        stream: true,
        messages: [{ role: 'user', content: sceneContent(provider, 'stream') }],
      });
      const text = await streamed.text();
      expect(streamed.status, provider).toBe(200);
      expect(doneCount(text), provider).toBe(1);
      expect(grewOnly(streamBefore, snapshot(doubles), provider), provider).toBe(true);
      const timeoutBefore = snapshot(doubles);
      const timed = await matrixChat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'timeout') }],
      });
      const timedBody = (await timed.json()) as { error?: { code?: string } };
      expect(timed.status, provider).toBe(504);
      expect(timedBody.error?.code).toBe('timeout');
      expect(grewOnly(timeoutBefore, snapshot(doubles), provider), provider).toBe(true);
      const downBefore = snapshot(doubles);
      const down = await matrixChat(port, tenant.tenantId, tenant.secret, {
        model: names[provider],
        messages: [{ role: 'user', content: sceneContent(provider, 'down') }],
      });
      const downBody = (await down.json()) as { error?: { code?: string } };
      expect(down.status, provider).toBe(502);
      expect(downBody.error?.code).toBe('upstream_error');
      expect(grewOnly(downBefore, snapshot(doubles), provider), provider).toBe(true);
      const cancelBefore = snapshot(doubles);
      const pending = openPost(port, tenant.tenantId, tenant.secret, chatPayload(names[provider], sceneContent(provider, 'cancel'), { stream: true }));
      await waitFor(async () => {
        if (snapshot(doubles)[provider] !== cancelBefore[provider] + 1) return false;
        const row = await latestAttempt(admin, tenant.tenantId);
        return row.stream_status === 'streaming' || row.stream_status === 'connecting';
      }, `${provider} cancel started`);
      pending.destroy();
      const cancelled = await pending.settled;
      expect(doneCount(cancelled.raw), provider).toBe(0);
      await waitFor(async () => {
        const row = await latestAttempt(admin, tenant.tenantId);
        return row.stream_status === 'client_aborted' && row.error_code === 'request_cancelled';
      }, `${provider} cancelled`);
      expect(grewOnly(cancelBefore, snapshot(doubles), provider), provider).toBe(true);
      proof.push({ provider, json: 200, streamDone: 1, timeout: 504, down: 502, cancelDone: 0 });
    }
    expect(doubles.dgxHits.length).toBeGreaterThan(0);
    expect(doubles.dgxHits.every((hit) => hit.url.includes('dgx.lab.internal'))).toBe(true);
    expect(doubles.dgxHits.some((hit) => hit.url.includes('api.openai.com') || hit.url.includes('api.x.ai'))).toBe(false);
    console.log(`SECTION providers ${JSON.stringify(proof)}`);
  }, 180_000);
});
