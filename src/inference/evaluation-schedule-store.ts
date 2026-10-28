import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import { proxyError, invalidRequest } from './errors.js';
import { cancelEvaluation, createEvaluation, parseEvaluationPlan, parseIdempotencyKey } from './evaluations.js';
import { scaleDecimal } from './evaluation-preflight.js';
import {
  SCHEDULE_CANDIDATE_CAP,
  decideSchedule,
  formatMoney,
  parseScheduleWrite,
  productionCapacityConstrained,
  scheduleRequestHash,
  stateDrift,
  tickRunKey,
  tickSkipKey,
  utcDay,
  utcMonthStart,
  type DriftReport,
  type ScheduleChoice,
  type ScheduleWrite,
  type SpendFacts,
} from './evaluation-schedule.js';

const PAGE_CAP = 50;
const DRIFT_RUN_CAP = 200;
const DRIFT_SAMPLE_CAP = 5000;

export type ScheduleContext = {
  scheduleTenantIds: readonly string[];
  globalKill: boolean;
  now: Date;
};

export type ScheduleView = {
  enabled: boolean;
  dailyLimit: string;
  monthlyLimit: string;
  perRunMaxExpense: string;
  maxChallengerCalls: number;
  maxJudgeCalls: number;
  maxConcurrentJobs: number;
  maxDurationMs: number;
  maxSamples: number;
  challengerDeployment: string;
  judgeDeployment: string | null;
  profileVersionId: string | null;
  rubricVersionId: string | null;
  sampleCategory: string;
  createdAt: string;
  updatedAt: string;
};

export type DecisionView = {
  id: string;
  kind: 'tick' | 'manual';
  action: 'run' | 'skip';
  skipReason: string | null;
  reasonCodes: string[];
  selectedSampleIds: string[];
  runId: string | null;
  asOf: string;
  fresh: boolean;
};

type DecisionRow = {
  id: string;
  kind: string;
  action: string;
  skip_reason: string | null;
  reason_codes: string[];
  selected_sample_ids: string[];
  run_id: string | null;
  as_of: Date;
};

type ScheduleRow = {
  enabled: boolean;
  daily_limit: string;
  monthly_limit: string;
  per_run_max_expense: string;
  max_challenger_calls: number;
  max_judge_calls: number;
  max_concurrent_jobs: number;
  max_duration_ms: number;
  max_samples: number;
  challenger_deployment: string;
  judge_deployment: string | null;
  profile_version_id: string | null;
  rubric_version_id: string | null;
  sample_category: string;
  request_hash: string;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
};

const DECISION_COLUMNS = `id::text AS id, kind, action, skip_reason, reason_codes, selected_sample_ids::text[] AS selected_sample_ids,
  run_id::text AS run_id, as_of`;

function namedTenant(ctx: ScheduleContext, tenantId: string): boolean {
  const id = tenantId.toLowerCase();
  return ctx.scheduleTenantIds.some((entry) => entry.toLowerCase() === id);
}

function schedulerEnabled(ctx: ScheduleContext): boolean {
  return ctx.scheduleTenantIds.length > 0;
}

function notFound(): never {
  throw proxyError(404, 'invalid_request_error', 'not_found', 'tenant_id', 'The schedule was not found.');
}

function moneyText(value: string | null): string {
  if (value === null) return '0';
  const scaled = scaleDecimal(value.trim());
  return formatMoney(scaled ?? 0n);
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function scheduleFromRow(row: ScheduleRow): ScheduleView {
  return {
    enabled: row.enabled,
    dailyLimit: moneyText(row.daily_limit),
    monthlyLimit: moneyText(row.monthly_limit),
    perRunMaxExpense: moneyText(row.per_run_max_expense),
    maxChallengerCalls: row.max_challenger_calls,
    maxJudgeCalls: row.max_judge_calls,
    maxConcurrentJobs: row.max_concurrent_jobs,
    maxDurationMs: row.max_duration_ms,
    maxSamples: row.max_samples,
    challengerDeployment: row.challenger_deployment,
    judgeDeployment: row.judge_deployment,
    profileVersionId: row.profile_version_id,
    rubricVersionId: row.rubric_version_id,
    sampleCategory: row.sample_category,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function writeFromRow(row: ScheduleRow): ScheduleWrite {
  return {
    enabled: row.enabled,
    dailyLimit: moneyText(row.daily_limit),
    monthlyLimit: moneyText(row.monthly_limit),
    perRunMaxExpense: moneyText(row.per_run_max_expense),
    maxChallengerCalls: row.max_challenger_calls,
    maxJudgeCalls: row.max_judge_calls,
    maxConcurrentJobs: row.max_concurrent_jobs,
    maxDurationMs: row.max_duration_ms,
    maxSamples: row.max_samples,
    challengerDeployment: row.challenger_deployment,
    judgeDeployment: row.judge_deployment,
    profileVersionId: row.profile_version_id,
    rubricVersionId: row.rubric_version_id,
    sampleCategory: row.sample_category as ScheduleWrite['sampleCategory'],
  };
}

function decisionFromRow(row: DecisionRow, fresh: boolean): DecisionView {
  return {
    id: row.id,
    kind: row.kind === 'manual' ? 'manual' : 'tick',
    action: row.action === 'run' ? 'run' : 'skip',
    skipReason: row.skip_reason,
    reasonCodes: row.reason_codes,
    selectedSampleIds: row.selected_sample_ids ?? [],
    runId: row.run_id,
    asOf: iso(row.as_of),
    fresh,
  };
}

async function lockControl(client: PoolClient): Promise<{ kill: boolean; dailyLimit: string; monthlyLimit: string }> {
  const result = await client.query<{ kill_switch: boolean; global_daily_limit: string; global_monthly_limit: string }>(
    `SELECT kill_switch, global_daily_limit::text AS global_daily_limit, global_monthly_limit::text AS global_monthly_limit
     FROM lock_evaluation_control()`,
  );
  const row = result.rows[0];
  if (row === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return {
    kill: row.kill_switch,
    dailyLimit: moneyText(row.global_daily_limit),
    monthlyLimit: moneyText(row.global_monthly_limit),
  };
}

async function readScheduleRow(client: PoolClient): Promise<ScheduleRow | null> {
  const result = await client.query<ScheduleRow>(
    `SELECT enabled, daily_limit::text, monthly_limit::text, per_run_max_expense::text,
            max_challenger_calls, max_judge_calls, max_concurrent_jobs, max_duration_ms, max_samples,
            challenger_deployment, judge_deployment, profile_version_id::text, rubric_version_id::text,
            sample_category, request_hash, idempotency_key, created_at, updated_at
     FROM evaluation_schedules`,
  );
  return result.rows[0] ?? null;
}

async function readDecisionBy(client: PoolClient, column: 'idempotency_key' | 'decision_key', value: string): Promise<DecisionRow | null> {
  const result = await client.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM evaluation_schedule_decisions WHERE ${column} = $1`,
    [value],
  );
  return result.rows[0] ?? null;
}

async function loadSpend(client: PoolClient, now: Date, globalDaily: string, globalMonthly: string): Promise<SpendFacts> {
  const day = now.toISOString().slice(0, 10);
  const month = utcMonthStart(now);
  const reserved = await client.query<{
    daily_amount: string;
    monthly_amount: string;
    challenger_calls: number;
    judge_calls: number;
  }>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE period_day = $1::date), 0)::text AS daily_amount,
            COALESCE(SUM(amount) FILTER (WHERE period_month = $2::date), 0)::text AS monthly_amount,
            COALESCE(SUM(challenger_calls) FILTER (WHERE period_day = $1::date), 0)::int AS challenger_calls,
            COALESCE(SUM(judge_calls) FILTER (WHERE period_day = $1::date), 0)::int AS judge_calls
     FROM evaluation_budget_reservations
     WHERE status = 'reserved'`,
    [day, month],
  );
  const global = await client.query<{ daily_amount: string; monthly_amount: string }>(
    `SELECT daily_amount::text AS daily_amount, monthly_amount::text AS monthly_amount
     FROM evaluation_global_reserved($1::date, $2::date)`,
    [day, month],
  );
  const open = await client.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM evaluation_runs
     WHERE status IN ('created', 'preflight', 'queued', 'running', 'cancel_requested')`,
  );
  const local = reserved.rows[0];
  const shared = global.rows[0];
  return {
    tenantDaily: moneyText(local?.daily_amount ?? '0'),
    tenantMonthly: moneyText(local?.monthly_amount ?? '0'),
    globalDaily: moneyText(shared?.daily_amount ?? '0'),
    globalMonthly: moneyText(shared?.monthly_amount ?? '0'),
    globalDailyLimit: globalDaily,
    globalMonthlyLimit: globalMonthly,
    challengerCallsToday: local?.challenger_calls ?? 0,
    judgeCallsToday: local?.judge_calls ?? 0,
    openRuns: open.rows[0]?.count ?? 0,
  };
}

async function loadCapacity(client: PoolClient, tenantId: string): Promise<boolean> {
  const limits = await client.query<{ mode: string | null; concurrent_requests: number | null }>(
    `SELECT mode, concurrent_requests FROM tenant_limit_policies`,
  );
  const policy = limits.rows[0];
  const used = await client.query<{ in_use: number }>(
    `SELECT concurrent_requests::int AS in_use
     FROM read_tenant_capacity(
       $1::uuid,
       statement_timestamp(),
       date_trunc('minute', statement_timestamp()),
       date_trunc('month', statement_timestamp())::date
     )`,
    [tenantId],
  );
  return productionCapacityConstrained({
    mode: policy?.mode ?? null,
    limit: policy?.concurrent_requests ?? null,
    inUse: used.rows[0]?.in_use ?? 0,
  });
}

async function loadCandidates(client: PoolClient, write: ScheduleWrite): Promise<import('./evaluation-schedule.js').CandidateFact[]> {
  const result = await client.query<{
    id: string;
    workload_volume: number;
    coverage: number;
    evidence_age_days: number | null;
    model_changed: boolean | null;
    config_changed: boolean | null;
    price_changed: boolean | null;
    quality_regression: boolean | null;
    efficiency_micros: string | null;
    efficiency_known: boolean | null;
    uncertainty: number;
  }>(
    `WITH deployment AS (
       SELECT d.upstream_model, d.config_version, d.capabilities, c.provider
       FROM model_deployments d
       JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
       WHERE d.name = $1 AND d.enabled IS TRUE AND c.enabled IS TRUE
       LIMIT 1
     ),
     policy AS (
       SELECT replay_permitted, allowed_deployments, allowed_providers
       FROM sample_policies
       ORDER BY policy_version DESC
       LIMIT 1
     ),
     price AS (
       SELECT pv.id
       FROM price_versions pv
       JOIN deployment d ON d.provider = pv.provider AND d.upstream_model = pv.model
       WHERE pv.effective_at <= statement_timestamp()
       ORDER BY pv.effective_at DESC
       LIMIT 1
     ),
     eligible AS (
       SELECT s.id, s.request_id, s.task_category
       FROM request_samples s
       CROSS JOIN policy p
       JOIN deployment d ON true
       WHERE s.task_category = $2
         AND s.expires_at > statement_timestamp()
         AND s.exchange_complete IS TRUE
         AND s.content_bytes > 0
         AND s.deletion_hold IS FALSE
         AND s.required_capabilities IS NOT NULL
         AND s.required_capabilities <@ d.capabilities
         AND p.replay_permitted IS TRUE
         AND $1 = ANY (p.allowed_deployments)
         AND d.provider = ANY (p.allowed_providers)
       ORDER BY s.id
       LIMIT $3
     )
     SELECT e.id::text AS id,
            (SELECT count(*)::int FROM request_samples w
              WHERE w.task_category = e.task_category
                AND w.created_at > statement_timestamp() - interval '7 days') AS workload_volume,
            CASE WHEN ev.last_at IS NULL THEN 0 ELSE 1 END AS coverage,
            CASE WHEN ev.last_at IS NULL THEN NULL
                 ELSE floor(extract(epoch FROM (statement_timestamp() - ev.last_at)) / 86400)::int
            END AS evidence_age_days,
            (orig.upstream_model IS NOT NULL AND dep.upstream_model IS NOT NULL
              AND orig.upstream_model IS DISTINCT FROM dep.upstream_model) AS model_changed,
            (orig.deployment_config_version IS NOT NULL AND dep.config_version IS NOT NULL
              AND orig.deployment_config_version IS DISTINCT FROM dep.config_version) AS config_changed,
            (orig.price_version_id IS NOT NULL AND price.id IS NOT NULL
              AND orig.price_version_id IS DISTINCT FROM price.id) AS price_changed,
            COALESCE(qual.regressed, false) AS quality_regression,
            CASE WHEN orig.duration_ms IS NULL OR eff.latency_ms IS NULL THEN NULL
                 ELSE ((orig.duration_ms::bigint - eff.latency_ms::bigint) * 1000)::text
            END AS efficiency_micros,
            (orig.duration_ms IS NOT NULL AND eff.latency_ms IS NOT NULL) AS efficiency_known,
            CASE WHEN ev.last_at IS NULL THEN 1
                 WHEN COALESCE(unc.uncertain, false) THEN 0.75
                 ELSE 0
            END::float8 AS uncertainty
     FROM eligible e
     LEFT JOIN deployment dep ON true
     LEFT JOIN price ON true
     LEFT JOIN LATERAL (
       SELECT ma.upstream_model, ma.deployment_config_version, ma.duration_ms, ac.price_version_id
       FROM model_attempts ma
       LEFT JOIN attempt_costs ac ON ac.tenant_id = ma.tenant_id AND ac.attempt_id = ma.id
       WHERE ma.request_id = e.request_id AND ma.status = 'succeeded'
       ORDER BY ma.created_at
       LIMIT 1
     ) orig ON true
     LEFT JOIN LATERAL (
       SELECT max(r.created_at) AS last_at
       FROM evaluation_items i
       JOIN evaluation_runs r ON r.id = i.run_id
       WHERE i.sample_id = e.id AND r.status IN ('completed', 'completed_partial')
     ) ev ON true
     LEFT JOIN LATERAL (
       SELECT ea.latency_ms
       FROM evaluation_attempts ea
       WHERE ea.sample_id = e.id AND ea.status = 'completed' AND ea.latency_ms IS NOT NULL
       ORDER BY ea.created_at DESC
       LIMIT 1
     ) eff ON true
     LEFT JOIN LATERAL (
       SELECT latest.result = 'fail'
         AND EXISTS (
           SELECT 1
           FROM evaluation_validator_results earlier
           JOIN evaluation_items ei ON ei.id = earlier.item_id
           WHERE ei.sample_id = e.id
             AND earlier.candidate = 'challenger'
             AND earlier.result = 'pass'
             AND earlier.created_at < latest.created_at
         ) AS regressed
       FROM evaluation_validator_results latest
       JOIN evaluation_items li ON li.id = latest.item_id
       WHERE li.sample_id = e.id AND latest.candidate = 'challenger'
       ORDER BY latest.created_at DESC
       LIMIT 1
     ) qual ON true
     LEFT JOIN LATERAL (
       SELECT bool_or(v.result IN ('unknown', 'not_applicable')) AS uncertain
       FROM evaluation_validator_results v
       JOIN evaluation_items i ON i.id = v.item_id
       WHERE i.sample_id = e.id AND v.candidate = 'challenger'
     ) unc ON true`,
    [write.challengerDeployment, write.sampleCategory, SCHEDULE_CANDIDATE_CAP],
  );
  return result.rows.map((row) => ({
    id: row.id,
    workloadVolume: row.workload_volume,
    coverage: row.coverage,
    evidenceAgeDays: row.evidence_age_days,
    modelChanged: row.model_changed === true,
    configChanged: row.config_changed === true,
    priceChanged: row.price_changed === true,
    qualityRegression: row.quality_regression === true,
    efficiencyMicros: BigInt(row.efficiency_micros ?? '0'),
    efficiencyKnown: row.efficiency_known === true,
    uncertainty: row.uncertainty,
  }));
}

async function insertDecision(
  client: PoolClient,
  tenantId: string,
  input: {
    kind: 'tick' | 'manual';
    decisionKey: string;
    idempotencyKey: string | null;
    choice: ScheduleChoice;
    now: Date;
    openRuns: number;
  },
): Promise<DecisionRow | null> {
  const facts = {
    selectedCount: input.choice.sampleIds.length,
    openRuns: input.openRuns,
    challengerCalls: input.choice.challengerCalls,
    judgeCalls: input.choice.judgeCalls,
  };
  const inserted = await client.query<DecisionRow>(
    `INSERT INTO evaluation_schedule_decisions (
       tenant_id, kind, decision_key, idempotency_key, fingerprint, as_of, action,
       skip_reason, reason_codes, selected_sample_ids, facts
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10::uuid[], $11::jsonb)
     ON CONFLICT (tenant_id, decision_key) DO NOTHING
     RETURNING ${DECISION_COLUMNS}`,
    [
      tenantId,
      input.kind,
      input.decisionKey,
      input.idempotencyKey,
      input.choice.fingerprint,
      input.now,
      input.choice.action,
      input.choice.skipReason,
      input.choice.reasonCodes,
      input.choice.sampleIds,
      JSON.stringify(facts),
    ],
  );
  return inserted.rows[0] ?? null;
}

async function reserveAndCreate(
  client: PoolClient,
  tenantId: string,
  decision: DecisionRow,
  choice: ScheduleChoice,
  write: ScheduleWrite,
  now: Date,
  decisionKey: string,
): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  await client.query(
    `INSERT INTO evaluation_budget_reservations (
       tenant_id, decision_id, amount, status, period_day, period_month, challenger_calls, judge_calls
     )
     VALUES ($1, $2, $3::numeric, 'reserved', $4::date, $5::date, $6, $7)`,
    [tenantId, decision.id, choice.reservedAmount, day, utcMonthStart(now), choice.challengerCalls, choice.judgeCalls],
  );
  const plan = parseEvaluationPlan({
    name: decision.kind === 'manual' ? `m${utcDay(now)}` : `s${utcDay(now)}`,
    sampleCategory: write.sampleCategory,
    sampleIds: choice.sampleIds,
    challengerDeployment: write.challengerDeployment,
    judgeDeployment: write.judgeDeployment,
    budgetEstimate: choice.reservedAmount,
    mode: 'replay',
    ...(write.profileVersionId === null ? {} : { profileVersionId: write.profileVersionId }),
    ...(write.rubricVersionId === null ? {} : { rubricVersionId: write.rubricVersionId }),
  });
  const created = await createEvaluation(client, tenantId, decisionKey, plan);
  await client.query(`UPDATE evaluation_schedule_decisions SET run_id = $2 WHERE id = $1`, [decision.id, created.run.id]);
  decision.run_id = created.run.id;
}

async function choose(
  client: PoolClient,
  tenantId: string,
  ctx: ScheduleContext,
  control: { kill: boolean; dailyLimit: string; monthlyLimit: string },
): Promise<{ choice: ScheduleChoice; write: ScheduleWrite | null; spend: SpendFacts }> {
  const row = await readScheduleRow(client);
  const write = row === null ? null : writeFromRow(row);
  const enabled = row?.enabled === true;
  const spend = await loadSpend(client, ctx.now, control.dailyLimit, control.monthlyLimit);
  const candidates = write === null || !enabled ? [] : await loadCandidates(client, write);
  const constrained = await loadCapacity(client, tenantId);
  const choice = decideSchedule({
    namedTenant: namedTenant(ctx, tenantId),
    schedulerEnabled: schedulerEnabled(ctx),
    kill: ctx.globalKill || control.kill,
    enabled,
    write,
    productionConstrained: constrained,
    spend,
    candidates,
    day: utcDay(ctx.now),
  });
  return { choice, write, spend };
}

export async function enableSchedule(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  body: unknown,
  ctx: ScheduleContext,
): Promise<{ schedule: ScheduleView; replayed: boolean }> {
  if (!namedTenant(ctx, tenantId)) notFound();
  const write = parseScheduleWrite(body);
  const hash = scheduleRequestHash(write);
  await lockControl(client);
  const existing = await readScheduleRow(client);
  if (existing !== null && existing.idempotency_key === idempotencyKey) {
    if (existing.request_hash !== hash) {
      throw proxyError(
        409,
        'invalid_request_error',
        'idempotency_conflict',
        'Idempotency-Key',
        'The idempotency key was used with a different request.',
      );
    }
    return { schedule: scheduleFromRow(existing), replayed: true };
  }
  const saved = await client.query<ScheduleRow>(
    `INSERT INTO evaluation_schedules (
       tenant_id, enabled, daily_limit, monthly_limit, per_run_max_expense,
       max_challenger_calls, max_judge_calls, max_concurrent_jobs, max_duration_ms, max_samples,
       challenger_deployment, judge_deployment, profile_version_id, rubric_version_id, sample_category,
       request_hash, idempotency_key
     )
     VALUES (
       $1, $2, $3::numeric, $4::numeric, $5::numeric,
       $6, $7, $8, $9, $10,
       $11, $12, $13, $14, $15,
       $16, $17
     )
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       daily_limit = EXCLUDED.daily_limit,
       monthly_limit = EXCLUDED.monthly_limit,
       per_run_max_expense = EXCLUDED.per_run_max_expense,
       max_challenger_calls = EXCLUDED.max_challenger_calls,
       max_judge_calls = EXCLUDED.max_judge_calls,
       max_concurrent_jobs = EXCLUDED.max_concurrent_jobs,
       max_duration_ms = EXCLUDED.max_duration_ms,
       max_samples = EXCLUDED.max_samples,
       challenger_deployment = EXCLUDED.challenger_deployment,
       judge_deployment = EXCLUDED.judge_deployment,
       profile_version_id = EXCLUDED.profile_version_id,
       rubric_version_id = EXCLUDED.rubric_version_id,
       sample_category = EXCLUDED.sample_category,
       request_hash = EXCLUDED.request_hash,
       idempotency_key = EXCLUDED.idempotency_key,
       updated_at = now()
     RETURNING enabled, daily_limit::text, monthly_limit::text, per_run_max_expense::text,
               max_challenger_calls, max_judge_calls, max_concurrent_jobs, max_duration_ms, max_samples,
               challenger_deployment, judge_deployment, profile_version_id::text, rubric_version_id::text,
               sample_category, request_hash, idempotency_key, created_at, updated_at`,
    [
      tenantId,
      write.enabled,
      write.dailyLimit,
      write.monthlyLimit,
      write.perRunMaxExpense,
      write.maxChallengerCalls,
      write.maxJudgeCalls,
      write.maxConcurrentJobs,
      write.maxDurationMs,
      write.maxSamples,
      write.challengerDeployment,
      write.judgeDeployment,
      write.profileVersionId,
      write.rubricVersionId,
      write.sampleCategory,
      hash,
      idempotencyKey,
    ],
  );
  const row = saved.rows[0];
  if (row === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return { schedule: scheduleFromRow(row), replayed: false };
}

export async function disableSchedule(client: PoolClient, tenantId: string, ctx: ScheduleContext): Promise<ScheduleView> {
  if (!namedTenant(ctx, tenantId)) notFound();
  await lockControl(client);
  const existing = await readScheduleRow(client);
  if (existing === null) notFound();
  if (!existing.enabled) return scheduleFromRow(existing);
  const disabled = writeFromRow(existing);
  disabled.enabled = false;
  const saved = await client.query<ScheduleRow>(
    `UPDATE evaluation_schedules
     SET enabled = false, request_hash = $1, idempotency_key = $2, updated_at = now()
     RETURNING enabled, daily_limit::text, monthly_limit::text, per_run_max_expense::text,
               max_challenger_calls, max_judge_calls, max_concurrent_jobs, max_duration_ms, max_samples,
               challenger_deployment, judge_deployment, profile_version_id::text, rubric_version_id::text,
               sample_category, request_hash, idempotency_key, created_at, updated_at`,
    [scheduleRequestHash(disabled), 'schedule-disabled'],
  );
  const row = saved.rows[0];
  if (row === undefined) notFound();
  return scheduleFromRow(row);
}

export async function readSchedule(client: PoolClient): Promise<ScheduleView | null> {
  const row = await readScheduleRow(client);
  return row === null ? null : scheduleFromRow(row);
}

export async function tickSchedule(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string | null,
  ctx: ScheduleContext,
): Promise<DecisionView> {
  const control = await lockControl(client);
  if (idempotencyKey !== null) {
    const stored = await readDecisionBy(client, 'idempotency_key', idempotencyKey);
    if (stored !== null) return decisionFromRow(stored, false);
  }
  const day = utcDay(ctx.now);
  const existingRun = await readDecisionBy(client, 'decision_key', tickRunKey(day));
  if (existingRun !== null) return decisionFromRow(existingRun, false);
  const { choice, write, spend } = await choose(client, tenantId, ctx, control);
  if (choice.action !== 'run' || write === null) {
    const reason = choice.skipReason ?? 'schedule_disabled';
    const skipKey = tickSkipKey(day, reason);
    const inserted = await insertDecision(client, tenantId, {
      kind: 'tick',
      decisionKey: skipKey,
      idempotencyKey,
      choice: { ...choice, action: 'skip', skipReason: reason, reasonCodes: [reason], sampleIds: [] },
      now: ctx.now,
      openRuns: spend.openRuns,
    });
    const row = inserted ?? (await readDecisionBy(client, 'decision_key', skipKey));
    if (row === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    return decisionFromRow(row, false);
  }
  const decisionKey = tickRunKey(day);
  const inserted = await insertDecision(client, tenantId, {
    kind: 'tick',
    decisionKey,
    idempotencyKey,
    choice,
    now: ctx.now,
    openRuns: spend.openRuns,
  });
  if (inserted === null) {
    const raced = await readDecisionBy(client, 'decision_key', decisionKey);
    if (raced === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    return decisionFromRow(raced, false);
  }
  await reserveAndCreate(client, tenantId, inserted, choice, write, ctx.now, decisionKey);
  const stored = await readDecisionBy(client, 'decision_key', decisionKey);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return decisionFromRow(stored, true);
}

export async function manualScheduleRun(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  ctx: ScheduleContext,
): Promise<DecisionView> {
  if (!namedTenant(ctx, tenantId)) notFound();
  const control = await lockControl(client);
  const storedKey = await readDecisionBy(client, 'idempotency_key', idempotencyKey);
  if (storedKey !== null) return decisionFromRow(storedKey, false);
  const { choice, write, spend } = await choose(client, tenantId, ctx, control);
  if (choice.action === 'skip' || write === null || choice.skipReason !== null) {
    const reason = choice.skipReason ?? 'schedule_disabled';
    const inserted = await insertDecision(client, tenantId, {
      kind: 'manual',
      decisionKey: idempotencyKey,
      idempotencyKey,
      choice: { ...choice, action: 'skip', skipReason: reason, reasonCodes: [reason], sampleIds: [] },
      now: ctx.now,
      openRuns: spend.openRuns,
    });
    const row = inserted ?? (await readDecisionBy(client, 'decision_key', idempotencyKey));
    if (row === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    return decisionFromRow(row, false);
  }
  const inserted = await insertDecision(client, tenantId, {
    kind: 'manual',
    decisionKey: idempotencyKey,
    idempotencyKey,
    choice,
    now: ctx.now,
    openRuns: spend.openRuns,
  });
  if (inserted === null) {
    const raced = await readDecisionBy(client, 'decision_key', idempotencyKey);
    if (raced === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
    return decisionFromRow(raced, false);
  }
  await reserveAndCreate(client, tenantId, inserted, choice, write, ctx.now, idempotencyKey);
  const stored = await readDecisionBy(client, 'decision_key', idempotencyKey);
  if (stored === null) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return decisionFromRow(stored, true);
}

export function parseSchedulePage(query: { limit?: string; cursor?: string }): { limit: number; cursor: string | null } {
  let limit = PAGE_CAP;
  if (query.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(query.limit)) {
      throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
    }
    limit = Number(query.limit);
    if (limit < 1 || limit > PAGE_CAP) throw invalidRequest('limit', 'invalid_parameter', 'limit must be an integer from 1 to 50.');
  }
  let cursor: string | null = null;
  if (query.cursor !== undefined) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query.cursor)) {
      throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
    }
    cursor = query.cursor.toLowerCase();
  }
  return { limit, cursor };
}

export async function listScheduleDecisions(
  client: PoolClient,
  query: { limit: number; cursor: string | null },
): Promise<{ decisions: DecisionView[]; nextCursor: string | null }> {
  if (query.cursor !== null) {
    const found = await client.query(`SELECT 1 FROM evaluation_schedule_decisions WHERE id = $1`, [query.cursor]);
    if ((found.rowCount ?? 0) === 0) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
  }
  const result = await client.query<DecisionRow>(
    `SELECT ${DECISION_COLUMNS}
     FROM evaluation_schedule_decisions
     WHERE (
       $1::uuid IS NULL
       OR (created_at, id) < (SELECT c.created_at, c.id FROM evaluation_schedule_decisions c WHERE c.id = $1)
     )
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [query.cursor, query.limit + 1],
  );
  const page = result.rows.slice(0, query.limit).map((row) => decisionFromRow(row, false));
  const last = page.at(-1);
  const nextCursor = result.rows.length > query.limit && last !== undefined ? last.id : null;
  return { decisions: page, nextCursor };
}

export function parseAsOf(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw invalidRequest('as_of', 'invalid_parameter', 'asOf is invalid.');
  }
  return new Date(value).toISOString();
}

export async function readScheduleDrift(client: PoolClient, asOf: string): Promise<DriftReport> {
  const runs = await client.query<{
    id: string;
    created_at: Date;
    sample_category: string;
    profile_version_id: string | null;
    rubric_version_id: string | null;
    sample_ids: string[] | null;
  }>(
    `SELECT r.id::text AS id, r.created_at, r.sample_category,
            r.profile_version_id::text AS profile_version_id, r.rubric_version_id::text AS rubric_version_id,
            COALESCE(array_agg(i.sample_id::text ORDER BY i.ordinal) FILTER (WHERE i.sample_id IS NOT NULL), '{}') AS sample_ids
     FROM evaluation_runs r
     LEFT JOIN evaluation_items i ON i.run_id = r.id AND i.created_at <= $1::timestamptz
     WHERE r.status IN ('completed', 'completed_partial')
       AND r.created_at <= $1::timestamptz
       AND r.updated_at <= $1::timestamptz
     GROUP BY r.id
     ORDER BY r.created_at, r.id
     LIMIT $2`,
    [asOf, DRIFT_RUN_CAP],
  );
  const runIds = runs.rows.map((row) => row.id);
  const attempts =
    runIds.length === 0
      ? []
      : (
          await client.query<{
            run_id: string;
            status: string;
            latency_ms: number | null;
            upstream_model: string;
            deployment_config_version: number;
            price_version_id: string | null;
          }>(
            `SELECT ea.run_id::text AS run_id, ea.status, ea.latency_ms, ma.upstream_model,
                    ma.deployment_config_version, ac.price_version_id::text AS price_version_id
             FROM evaluation_attempts ea
             JOIN model_attempts ma ON ma.tenant_id = ea.tenant_id AND ma.id = ea.model_attempt_id
             LEFT JOIN attempt_costs ac ON ac.tenant_id = ea.tenant_id AND ac.attempt_id = ma.id
             WHERE ea.run_id = ANY($1::uuid[])
               AND ea.created_at <= $2::timestamptz
               AND ea.updated_at <= $2::timestamptz`,
            [runIds, asOf],
          )
        ).rows;
  const validators =
    runIds.length === 0
      ? []
      : (
          await client.query<{ run_id: string; validator_id: string; result: string }>(
            `SELECT run_id::text AS run_id, validator_id, result
             FROM evaluation_validator_results
             WHERE candidate = 'challenger'
               AND run_id = ANY($1::uuid[])
               AND created_at <= $2::timestamptz`,
            [runIds, asOf],
          )
        ).rows;
  const deployments = await client.query<{ name: string; upstream_model: string; config_version: number; created_at: Date }>(
    `SELECT name, upstream_model, config_version, created_at
     FROM model_deployments
     WHERE created_at <= $1::timestamptz`,
    [asOf],
  );
  const samples = await client.query<{ category: string; created_at: Date }>(
    `SELECT COALESCE(task_category, 'unknown') AS category, created_at
     FROM request_samples
     WHERE created_at <= $1::timestamptz
     ORDER BY created_at DESC
     LIMIT $2`,
    [asOf, DRIFT_SAMPLE_CAP],
  );
  return stateDrift({
    asOf,
    runs: runs.rows.map((row) => {
      const runAttempts = attempts.filter((attempt) => attempt.run_id === row.id);
      const runValidators = validators.filter((validator) => validator.run_id === row.id);
      const schema = runValidators.filter((validator) => validator.validator_id === 'json_parse');
      return {
        id: row.id,
        createdAt: iso(row.created_at),
        taskCategory: row.sample_category,
        profileVersionId: row.profile_version_id,
        rubricVersionId: row.rubric_version_id,
        sampleIds: row.sample_ids ?? [],
        pass: runValidators.filter((validator) => validator.result === 'pass').length,
        fail: runValidators.filter((validator) => validator.result === 'fail').length,
        schemaFail: schema.filter((validator) => validator.result === 'fail').length,
        schemaChecked: schema.length,
        latencies: runAttempts.flatMap((attempt) => (attempt.latency_ms === null ? [] : [attempt.latency_ms])),
        completedAttempts: runAttempts.filter((attempt) => attempt.status === 'completed').length,
        attempts: runAttempts.length,
        upstreamModels: [...new Set(runAttempts.map((attempt) => attempt.upstream_model))],
        configVersions: [...new Set(runAttempts.map((attempt) => attempt.deployment_config_version))],
        priceVersionIds: [...new Set(runAttempts.flatMap((attempt) => (attempt.price_version_id === null ? [] : [attempt.price_version_id])))],
      };
    }),
    deployments: deployments.rows.map((row) => ({
      name: row.name,
      upstreamModel: row.upstream_model,
      configVersion: row.config_version,
      createdAt: iso(row.created_at),
    })),
    samples: samples.rows.map((row) => ({ category: row.category, createdAt: iso(row.created_at) })),
  });
}

export function parseKillBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The control body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== 'killSwitch' || typeof record.killSwitch !== 'boolean') {
    throw invalidRequest('kill_switch', 'invalid_parameter', 'killSwitch is invalid.');
  }
  return record.killSwitch;
}

export async function setEvaluationKill(client: PoolClient, tenantId: string, kill: boolean, ctx: ScheduleContext): Promise<{ killSwitch: boolean }> {
  if (!schedulerEnabled(ctx) || !namedTenant(ctx, tenantId)) notFound();
  await lockControl(client);
  const saved = await client.query<{ kill_switch: boolean }>(
    `UPDATE evaluation_controls SET kill_switch = $1, updated_at = now() WHERE singleton RETURNING kill_switch`,
    [kill],
  );
  const row = saved.rows[0];
  if (row === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return { killSwitch: row.kill_switch };
}

export async function cancelOverdueScheduleRuns(pool: Pool, tenantIds: readonly string[]): Promise<void> {
  for (const tenantId of tenantIds) {
    const ids = await withTenant(pool, tenantId, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT r.id::text AS id
         FROM evaluation_runs r
         JOIN evaluation_schedule_decisions d ON d.tenant_id = r.tenant_id AND d.run_id = r.id
         JOIN evaluation_schedules s ON s.tenant_id = r.tenant_id
         WHERE r.status IN ('queued', 'running')
           AND r.created_at + (s.max_duration_ms::text || ' milliseconds')::interval < statement_timestamp()`,
      );
      return result.rows.map((row) => row.id);
    });
    for (const id of ids) {
      await withTenant(pool, tenantId, (client) => cancelEvaluation(client, id));
    }
  }
}

export async function maintainEvaluationSchedule(
  pool: Pool,
  options: { dryRun: boolean; executionEnabled: boolean; scheduleTenantIds?: readonly string[]; globalKill?: boolean },
): Promise<{ created: boolean }> {
  const tenants = options.scheduleTenantIds ?? [];
  const tenantId = tenants.length === 1 ? tenants[0] : undefined;
  if (options.dryRun || !options.executionEnabled || tenantId === undefined) return { created: false };
  const decision = await withTenant(pool, tenantId, (client) =>
    tickSchedule(client, tenantId, null, {
      scheduleTenantIds: tenants,
      globalKill: options.globalKill === true,
      now: new Date(),
    }),
  );
  return { created: decision.fresh && decision.action === 'run' };
}

export function requireIdempotencyKey(header: string | string[] | undefined): string {
  return parseIdempotencyKey(header);
}
