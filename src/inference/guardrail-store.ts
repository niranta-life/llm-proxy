import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { readRollout, type RolloutView } from './canary-rollout.js';
import { invalidRequest, proxyError } from './errors.js';
import {
  CONSERVATIVE_DEFAULTS,
  emptyCohort,
  isGuardrailKind,
  signalAllowed,
  type CohortSnapshot,
  type CohortTotals,
  type GuardrailRule,
} from './guardrail-decision.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FEEDBACK_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const SOURCE = /^[a-z][a-z0-9_-]{0,63}$/;
const VERSION = /^[A-Za-z0-9._-]{1,64}$/;
const METRICS = new Set(['task_success', 'schema_valid', 'correctness']);
const RESULTS = new Set(['pass', 'fail', 'unknown']);
const FORBIDDEN = new Set([
  'prompt',
  'output',
  'completion',
  'content',
  'messages',
  'response',
  'text',
  'ciphertext',
]);

const ERROR_CLASSES = [
  'upstream_error',
  'unavailable',
  'connection_failure',
  'ambiguous_network',
  'client_error',
  'unauthorized',
];
const TIMEOUT_CLASSES = ['timeout_before_dispatch', 'timeout_after_dispatch', 'total_deadline'];

export type FeedbackWrite = {
  requestId: string;
  feedbackId: string;
  source: string;
  metric: 'task_success' | 'schema_valid' | 'correctness';
  result: 'pass' | 'fail' | 'unknown';
  validatorVersion: string;
  observedAt: string;
  supersededFeedbackId: string | null;
};

export type FeedbackView = FeedbackWrite & { id: string; createdAt: string };

export type GuardrailAttach = {
  rolloutId: string;
  approvedSources: string[];
  rules: Array<Omit<GuardrailRule, 'id'>>;
};

export type MetricSeries = {
  policyVersionId: string | null;
  cohort: 'baseline' | 'canary';
  cohortDeployment: string;
  executedDeployment: string;
  taskSegment: string;
  assignments: number;
  executions: number;
  errorRate: number | null;
  timeoutRate: number | null;
  incompleteStreamRate: number | null;
  retryRate: number | null;
  fallbackRate: number | null;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  costPerRequest: string | null;
  costPerCompletedRequest: string | null;
  schemaValidationFailures: number;
  providerSuccesses: number;
  trustedQuality: {
    taskSuccess: { pass: number; fail: number; unknown: number; mature: number; missing: number; immature: number };
    schemaValid: { pass: number; fail: number; unknown: number; mature: number; missing: number; immature: number };
    correctness: { pass: number; fail: number; unknown: number; mature: number; missing: number; immature: number };
  };
  evaluationQuality: { pass: number; fail: number; unknown: number };
  feedback: { mature: number; missing: number; immature: number };
};

export type ViolationView = {
  id: string;
  rolloutId: string;
  ruleId: string | null;
  trigger: 'operator' | 'guardrail';
  kind: string;
  signal: string;
  reason: string;
  epoch: number;
  evidence: Record<string, number | null>;
  createdAt: string;
};

export type GuardrailView = {
  id: string;
  rolloutId: string;
  approvedSources: string[];
  rules: GuardrailRule[];
  metrics: MetricSeries[];
  cohorts: CohortTotals[];
  capabilityViolations: number;
  violations: ViolationView[];
};

export type ActiveGuardrail = {
  id: string;
  rolloutId: string;
  epoch: number;
  rules: GuardrailRule[];
};

type RawCounts = {
  policy_version_id: string | null;
  cohort: 'baseline' | 'canary';
  cohort_deployment: string;
  executed_deployment: string;
  task_segment: string;
  assignments: number;
  executions: number;
  error_requests: number;
  timeout_requests: number;
  incomplete_requests: number;
  retry_requests: number;
  fallback_requests: number;
  latency_p50: string | null;
  latency_p95: string | null;
  latency_samples: number;
  cost_sum: string;
  cost_samples: number;
  completed_cost_sum: string;
  completed_requests: number;
  provider_successes: number;
  schema_passes: number;
  schema_failures: number;
  schema_unknown: number;
  schema_missing: number;
  schema_immature: number;
  task_passes: number;
  task_failures: number;
  task_unknown: number;
  task_missing: number;
  task_immature: number;
  correct_passes: number;
  correct_failures: number;
  correct_unknown: number;
  correct_missing: number;
  correct_immature: number;
};

export function parseFeedbackWrite(body: unknown): FeedbackWrite {
  const record = objectBody(body, 'The feedback body is invalid.');
  for (const key of Object.keys(record)) {
    if (FORBIDDEN.has(key)) {
      throw invalidRequest(key, 'invalid_parameter', 'The feedback body contains a prompt or a model output.');
    }
  }
  const allowed = new Set([
    'requestId',
    'feedbackId',
    'source',
    'metric',
    'result',
    'validatorVersion',
    'timestamp',
    'supersededFeedbackId',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The feedback body is invalid.');
  }
  const metric = record.metric;
  if (typeof metric !== 'string' || !METRICS.has(metric)) {
    throw invalidRequest('metric', 'invalid_parameter', 'metric is invalid.');
  }
  const result = record.result;
  if (typeof result !== 'string' || !RESULTS.has(result)) {
    throw invalidRequest('result', 'invalid_parameter', 'result is invalid.');
  }
  const superseded = record.supersededFeedbackId;
  return {
    requestId: uuidField(record.requestId, 'requestId'),
    feedbackId: tokenField(record.feedbackId, 'feedbackId', FEEDBACK_ID),
    source: tokenField(record.source, 'source', SOURCE),
    metric: metric as FeedbackWrite['metric'],
    result: result as FeedbackWrite['result'],
    validatorVersion: tokenField(record.validatorVersion, 'validatorVersion', VERSION),
    observedAt: timestampField(record.timestamp),
    supersededFeedbackId:
      superseded === undefined || superseded === null ? null : tokenField(superseded, 'supersededFeedbackId', FEEDBACK_ID),
  };
}

export function parseGuardrailAttach(body: unknown): GuardrailAttach {
  const record = objectBody(body, 'The policy body is invalid.');
  const allowed = new Set(['rolloutId', 'approvedSources', 'rules']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The policy body is invalid.');
  }
  if (!Array.isArray(record.approvedSources) || record.approvedSources.length < 1 || record.approvedSources.length > 8) {
    throw invalidRequest('approvedSources', 'invalid_parameter', 'approvedSources is invalid.');
  }
  const approvedSources = record.approvedSources.map((value) => tokenField(value, 'approvedSources', SOURCE));
  if (new Set(approvedSources).size !== approvedSources.length) {
    throw invalidRequest('approvedSources', 'invalid_parameter', 'approvedSources is invalid.');
  }
  if (!Array.isArray(record.rules) || record.rules.length < 1 || record.rules.length > 8) {
    throw invalidRequest('rules', 'invalid_parameter', 'rules is invalid.');
  }
  return {
    rolloutId: uuidField(record.rolloutId, 'rolloutId'),
    approvedSources,
    rules: record.rules.map((rule) => parseRule(rule)),
  };
}

export function parseRollbackBody(body: unknown): { expectedEpoch: number } {
  const record = objectBody(body, 'The policy body is invalid.');
  if ('promote' in record) {
    throw proxyError(400, 'invalid_request_error', 'promotion_rejected', 'promote', 'A canary cannot promote itself.');
  }
  if (Object.keys(record).length !== 1) throw invalidRequest('body', 'invalid_parameter', 'The policy body is invalid.');
  return { expectedEpoch: integerField(record.expectedEpoch, 'expectedEpoch', 1, 1_000_000) };
}

export async function recordFeedback(
  client: PoolClient,
  tenantId: string,
  write: FeedbackWrite,
): Promise<{ feedback: FeedbackView; created: boolean }> {
  const requestHash = sha256(canonicalFeedback(write));
  const existing = await client.query<{ request_hash: string } & FeedbackRow>(
    `SELECT ${FEEDBACK_COLUMNS}
     FROM routing_task_feedback
     WHERE feedback_id = $1`,
    [write.feedbackId],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== requestHash) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'feedbackId', 'The idempotency key was reused.');
    }
    return { feedback: feedbackView(stored), created: false };
  }
  const request = await client.query(`SELECT id FROM proxy_requests WHERE id = $1`, [write.requestId]);
  if ((request.rowCount ?? 0) !== 1) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'requestId', 'The request was not found.');
  }
  const approved = await client.query<{ approved_sources: string[] }>(
    `SELECT s.approved_sources
     FROM routing_canary_assignments a
     JOIN routing_guardrail_sets s ON s.tenant_id = a.tenant_id AND s.rollout_id = a.rollout_id
     WHERE a.request_id = $1`,
    [write.requestId],
  );
  const sources = approved.rows[0]?.approved_sources ?? [];
  if (!sources.includes(write.source)) {
    throw invalidRequest('source', 'unapproved_source', 'The feedback source is not approved.');
  }
  if (write.supersededFeedbackId !== null) {
    if (write.supersededFeedbackId === write.feedbackId) {
      throw invalidRequest('supersededFeedbackId', 'invalid_parameter', 'supersededFeedbackId is invalid.');
    }
    const prior = await client.query(`SELECT 1 FROM routing_task_feedback WHERE feedback_id = $1`, [write.supersededFeedbackId]);
    if ((prior.rowCount ?? 0) !== 1) {
      throw invalidRequest('supersededFeedbackId', 'invalid_parameter', 'supersededFeedbackId is invalid.');
    }
  }
  const conflict = await client.query(
    `SELECT 1
     FROM routing_task_feedback f
     WHERE f.request_id = $1
       AND f.metric = $2
       AND f.source = $3
       AND f.result <> $4
       AND NOT EXISTS (
         SELECT 1 FROM routing_task_feedback newer
         WHERE newer.tenant_id = f.tenant_id AND newer.superseded_feedback_id = f.feedback_id
       )
       AND ($5::text IS NULL OR f.feedback_id <> $5::text)`,
    [write.requestId, write.metric, write.source, write.result, write.supersededFeedbackId],
  );
  if ((conflict.rowCount ?? 0) > 0) {
    throw proxyError(409, 'invalid_request_error', 'feedback_conflict', 'result', 'The feedback conflicts with a stored record.');
  }
  try {
    const inserted = await client.query<FeedbackRow>(
      `INSERT INTO routing_task_feedback (
         tenant_id, request_id, feedback_id, source, metric, result, validator_version,
         observed_at, superseded_feedback_id, request_hash
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${FEEDBACK_COLUMNS}`,
      [
        tenantId,
        write.requestId,
        write.feedbackId,
        write.source,
        write.metric,
        write.result,
        write.validatorVersion,
        write.observedAt,
        write.supersededFeedbackId,
        requestHash,
      ],
    );
    const row = inserted.rows[0];
    if (row === undefined) throw new Error('feedback was not stored');
    return { feedback: feedbackView(row), created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await client.query<{ request_hash: string } & FeedbackRow>(
      `SELECT ${FEEDBACK_COLUMNS} FROM routing_task_feedback WHERE feedback_id = $1`,
      [write.feedbackId],
    );
    const replay = raced.rows[0];
    if (replay?.request_hash === requestHash) return { feedback: feedbackView(replay), created: false };
    throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'feedbackId', 'The idempotency key was reused.');
  }
}

export async function attachGuardrails(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  write: GuardrailAttach,
): Promise<{ guardrail: GuardrailView; created: boolean }> {
  const requestHash = sha256(canonicalAttach(write));
  const existing = await client.query<{ set_id: string; request_hash: string }>(
    `SELECT id::text AS set_id, request_hash FROM routing_guardrail_sets WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== requestHash) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return { guardrail: await readGuardrail(client, stored.set_id), created: false };
  }
  const rollout = await client.query<{ status: string }>(`SELECT status FROM routing_rollouts WHERE id = $1`, [write.rolloutId]);
  const status = rollout.rows[0]?.status;
  if (status === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rolloutId', 'The rollout was not found.');
  }
  if (status !== 'active') {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'rolloutId', 'The rollout epoch is stale.');
  }
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO routing_guardrail_sets (tenant_id, rollout_id, approved_sources, idempotency_key, request_hash)
       VALUES ($1, $2, $3::text[], $4, $5)
       RETURNING id::text AS id`,
      [tenantId, write.rolloutId, write.approvedSources, idempotencyKey, requestHash],
    );
    const setId = inserted.rows[0]?.id;
    if (setId === undefined) throw new Error('guardrail set was not stored');
    for (let index = 0; index < write.rules.length; index += 1) {
      const rule = write.rules[index];
      if (rule === undefined) continue;
      await client.query(
        `INSERT INTO routing_guardrail_rules (
           tenant_id, set_id, ordinal, kind, signal, threshold, margin, min_samples,
           window_seconds, maturity_seconds, max_missing_fraction
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          tenantId,
          setId,
          index + 1,
          rule.kind,
          rule.signal,
          rule.threshold,
          rule.margin,
          rule.minSamples,
          rule.windowSeconds,
          rule.maturitySeconds,
          rule.maxMissingFraction,
        ],
      );
    }
    return { guardrail: await readGuardrail(client, setId), created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await client.query<{ set_id: string; request_hash: string }>(
      `SELECT id::text AS set_id, request_hash FROM routing_guardrail_sets WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (raced.rows[0]?.request_hash === requestHash) {
      return { guardrail: await readGuardrail(client, raced.rows[0].set_id), created: false };
    }
    if ((raced.rowCount ?? 0) > 0) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    throw proxyError(409, 'invalid_request_error', 'guardrail_exists', 'rolloutId', 'A guardrail set is already attached.');
  }
}

export async function listGuardrails(client: PoolClient): Promise<GuardrailView[]> {
  const sets = await client.query<{ id: string }>(`SELECT id::text AS id FROM routing_guardrail_sets ORDER BY created_at, id`);
  const views: GuardrailView[] = [];
  for (const set of sets.rows) views.push(await readGuardrail(client, set.id));
  return views;
}

export async function listActiveGuardrails(client: PoolClient): Promise<ActiveGuardrail[]> {
  const result = await client.query<{ id: string; rollout_id: string; epoch: number }>(
    `SELECT s.id::text AS id, s.rollout_id::text AS rollout_id, r.epoch
     FROM routing_guardrail_sets s
     JOIN routing_rollouts r ON r.tenant_id = s.tenant_id AND r.id = s.rollout_id
     WHERE r.status = 'active'
     ORDER BY s.created_at, s.id`,
  );
  const active: ActiveGuardrail[] = [];
  for (const row of result.rows) {
    active.push({
      id: row.id,
      rolloutId: row.rollout_id,
      epoch: Number(row.epoch),
      rules: await readRules(client, row.id),
    });
  }
  return active;
}

export async function loadCohortMetrics(
  client: PoolClient,
  rolloutId: string,
  windowSeconds: number,
  maturitySeconds: number,
): Promise<{ series: MetricSeries[]; snapshot: CohortSnapshot; monitorRows: number }> {
  const [seriesResult, cohortResult, capability, evaluation, scanned] = await Promise.all([
    client.query<RawCounts>(seriesSql(), [rolloutId, windowSeconds, maturitySeconds]),
    client.query<RawCounts>(cohortSql(), [rolloutId, windowSeconds, maturitySeconds]),
    client.query<{ violations: number }>(
      `SELECT COUNT(*)::int AS violations
       FROM routing_capability_denials
       WHERE rollout_id = $1
         AND created_at >= statement_timestamp() - make_interval(secs => $2::int)`,
      [rolloutId, windowSeconds],
    ),
    client.query<{ deployment: string; side: 'canary' | 'baseline'; passes: number; fails: number; unknowns: number }>(
      `SELECT ea.challenger_deployment AS deployment, 'canary' AS side,
              COUNT(*) FILTER (WHERE r.result = 'pass')::int AS passes,
              COUNT(*) FILTER (WHERE r.result = 'fail')::int AS fails,
              COUNT(*) FILTER (WHERE r.result IN ('unknown', 'not_applicable'))::int AS unknowns
       FROM evaluation_validator_results r
       JOIN evaluation_attempts ea ON ea.tenant_id = r.tenant_id AND ea.item_id = r.item_id
       WHERE r.candidate = 'challenger'
         AND r.created_at >= statement_timestamp() - make_interval(secs => $1::int)
       GROUP BY ea.challenger_deployment
       UNION ALL
       SELECT ea.original_deployment AS deployment, 'baseline' AS side,
              COUNT(*) FILTER (WHERE r.result = 'pass')::int AS passes,
              COUNT(*) FILTER (WHERE r.result = 'fail')::int AS fails,
              COUNT(*) FILTER (WHERE r.result IN ('unknown', 'not_applicable'))::int AS unknowns
       FROM evaluation_validator_results r
       JOIN evaluation_attempts ea ON ea.tenant_id = r.tenant_id AND ea.item_id = r.item_id
       WHERE r.candidate = 'original'
         AND r.created_at >= statement_timestamp() - make_interval(secs => $1::int)
       GROUP BY ea.original_deployment`,
      [windowSeconds],
    ),
    client.query<{ rows: number }>(
      `SELECT COUNT(*)::int AS rows
       FROM routing_canary_assignments
       WHERE rollout_id = $1
         AND created_at >= statement_timestamp() - make_interval(secs => $2::int)`,
      [rolloutId, windowSeconds],
    ),
  ]);
  const capabilityViolations = Number(capability.rows[0]?.violations ?? 0);
  const cohorts = cohortResult.rows.map((row) => cohortFrom(row, evaluation.rows));
  const series = seriesResult.rows.map((row) => seriesFrom(row, evaluation.rows));
  return {
    series,
    snapshot: { cohorts, capabilityViolations },
    monitorRows: Number(scanned.rows[0]?.rows ?? 0),
  };
}

export async function rollbackRollout(
  client: PoolClient,
  tenantId: string,
  rolloutId: string,
  idempotencyKey: string,
  expectedEpoch: number,
  trigger: 'operator' | 'guardrail',
  violation: { ruleId: string | null; kind: string; signal: string; reason: string; evidence: Record<string, number | null> },
): Promise<{ rollout: RolloutView; violation: ViolationView }> {
  const requestHash = sha256(JSON.stringify({ rolloutId, action: 'rollback', expectedEpoch, trigger }));
  const existing = await client.query<{ rollout_id: string; request_hash: string; action: string }>(
    `SELECT rollout_id::text AS rollout_id, request_hash, action
     FROM routing_rollout_events
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== requestHash || stored.rollout_id !== rolloutId || stored.action !== 'stop') {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    const prior = await readViolationByKey(client, idempotencyKey);
    return { rollout: await readRollout(client, rolloutId), violation: prior };
  }
  const current = await client.query<{ epoch: number; status: string }>(
    `SELECT epoch, status FROM routing_rollouts WHERE id = $1`,
    [rolloutId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rollout_id', 'The rollout was not found.');
  }
  if (Number(row.epoch) !== expectedEpoch || row.status !== 'active') {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The rollout epoch is stale.');
  }
  const updated = await client.query<{ epoch: number }>(
    `UPDATE routing_rollouts
     SET status = 'stopped', stop_reason = 'critical_errors', stopped_at = statement_timestamp(),
         epoch = epoch + 1, updated_at = statement_timestamp()
     WHERE id = $1 AND epoch = $2 AND status = 'active'
     RETURNING epoch`,
    [rolloutId, expectedEpoch],
  );
  const epoch = updated.rows[0]?.epoch;
  if (epoch === undefined) {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The rollout epoch is stale.');
  }
  await client.query(
    `INSERT INTO routing_rollout_events (
       tenant_id, rollout_id, action, epoch, stop_reason, idempotency_key, request_hash
     )
     SELECT r.tenant_id, r.id, 'stop', $3, 'critical_errors', $4, $5
     FROM routing_rollouts r
     WHERE r.id = $2
       AND r.tenant_id::text = COALESCE(NULLIF($1::text, ''), r.tenant_id::text)`,
    [tenantId, rolloutId, Number(epoch), idempotencyKey, requestHash],
  );
  const evidence = evidenceObject(violation.evidence);
  const inserted = await client.query<{ id: string; created_at: Date }>(
    `INSERT INTO routing_guardrail_violations (
       tenant_id, rollout_id, rule_id, trigger, kind, signal, reason, epoch, evidence, idempotency_key
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
     RETURNING id::text AS id, created_at`,
    [
      tenantId,
      rolloutId,
      violation.ruleId,
      trigger,
      violation.kind,
      violation.signal,
      violation.reason,
      Number(epoch),
      JSON.stringify(evidence),
      idempotencyKey,
    ],
  );
  const violationRow = inserted.rows[0];
  if (violationRow === undefined) throw new Error('violation was not stored');
  return {
    rollout: await readRollout(client, rolloutId),
    violation: {
      id: violationRow.id,
      rolloutId,
      ruleId: violation.ruleId,
      trigger,
      kind: violation.kind,
      signal: violation.signal,
      reason: violation.reason,
      epoch: Number(epoch),
      evidence,
      createdAt: violationRow.created_at.toISOString(),
    },
  };
}

export async function recordCapabilityDenial(
  pool: Pool,
  logger: Logger,
  tenantId: string,
  rolloutId: string,
  deploymentId: string,
  parameter: string,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(parameter)) return;
  try {
    await withTenant(pool, tenantId, (client) =>
      client.query(
        `INSERT INTO routing_capability_denials (tenant_id, rollout_id, deployment_id, parameter)
         VALUES ($1, $2, $3, $4)`,
        [tenantId, rolloutId, deploymentId, parameter],
      ),
    );
  } catch (error) {
    logger.error('capability denial was not recorded', {
      message: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function readGuardrail(client: PoolClient, setId: string): Promise<GuardrailView> {
  const set = await client.query<{ id: string; rollout_id: string; approved_sources: string[] }>(
    `SELECT id::text AS id, rollout_id::text AS rollout_id, approved_sources
     FROM routing_guardrail_sets WHERE id = $1`,
    [setId],
  );
  const row = set.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'guardrail_id', 'The guardrail was not found.');
  }
  const rules = await readRules(client, setId);
  const windowSeconds = Math.max(...rules.map((rule) => rule.windowSeconds));
  const maturitySeconds = Math.min(...rules.map((rule) => rule.maturitySeconds));
  const metrics = await loadCohortMetrics(client, row.rollout_id, windowSeconds, maturitySeconds);
  const violations = await client.query<ViolationRow>(
    `SELECT id::text AS id, rollout_id::text AS rollout_id, rule_id::text AS rule_id, trigger, kind, signal,
            reason, epoch, evidence, created_at
     FROM routing_guardrail_violations
     WHERE rollout_id = $1
     ORDER BY created_at, id`,
    [row.rollout_id],
  );
  return {
    id: row.id,
    rolloutId: row.rollout_id,
    approvedSources: row.approved_sources,
    rules,
    metrics: metrics.series,
    cohorts: metrics.snapshot.cohorts,
    capabilityViolations: metrics.snapshot.capabilityViolations,
    violations: violations.rows.map(violationView),
  };
}

async function readRules(client: PoolClient, setId: string): Promise<GuardrailRule[]> {
  const result = await client.query<{
    id: string;
    kind: GuardrailRule['kind'];
    signal: string;
    threshold: string;
    margin: string;
    min_samples: number;
    window_seconds: number;
    maturity_seconds: number;
    max_missing_fraction: string;
  }>(
    `SELECT id::text AS id, kind, signal, threshold::text AS threshold, margin::text AS margin,
            min_samples, window_seconds, maturity_seconds, max_missing_fraction::text AS max_missing_fraction
     FROM routing_guardrail_rules
     WHERE set_id = $1
     ORDER BY ordinal`,
    [setId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    signal: row.signal,
    threshold: Number(row.threshold),
    margin: Number(row.margin),
    minSamples: Number(row.min_samples),
    windowSeconds: Number(row.window_seconds),
    maturitySeconds: Number(row.maturity_seconds),
    maxMissingFraction: Number(row.max_missing_fraction),
  }));
}

async function readViolationByKey(client: PoolClient, idempotencyKey: string): Promise<ViolationView> {
  const result = await client.query<ViolationRow>(
    `SELECT id::text AS id, rollout_id::text AS rollout_id, rule_id::text AS rule_id, trigger, kind, signal,
            reason, epoch, evidence, created_at
     FROM routing_guardrail_violations
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rollout_id', 'The rollout was not found.');
  }
  return violationView(row);
}

function seriesFrom(
  row: RawCounts,
  evaluation: readonly { deployment: string; side: 'canary' | 'baseline'; passes: number; fails: number; unknowns: number }[],
): MetricSeries {
  const cohort = cohortFrom(row, evaluation);
  const executions = Number(row.executions);
  return {
    policyVersionId: row.policy_version_id,
    cohort: row.cohort,
    cohortDeployment: row.cohort_deployment,
    executedDeployment: row.executed_deployment,
    taskSegment: row.task_segment,
    assignments: Number(row.assignments),
    executions,
    errorRate: rate(Number(row.error_requests), executions),
    timeoutRate: rate(Number(row.timeout_requests), executions),
    incompleteStreamRate: rate(Number(row.incomplete_requests), executions),
    retryRate: rate(Number(row.retry_requests), executions),
    fallbackRate: rate(Number(row.fallback_requests), executions),
    latencyP50Ms: numberOrNull(row.latency_p50),
    latencyP95Ms: numberOrNull(row.latency_p95),
    costPerRequest: perRequest(row.cost_sum, Number(row.assignments)),
    costPerCompletedRequest: perRequest(row.completed_cost_sum, Number(row.completed_requests)),
    schemaValidationFailures: Number(row.schema_failures),
    providerSuccesses: Number(row.provider_successes),
    trustedQuality: {
      taskSuccess: qualityBlock(row.task_passes, row.task_failures, row.task_unknown, row.task_missing, row.task_immature),
      schemaValid: qualityBlock(row.schema_passes, row.schema_failures, row.schema_unknown, row.schema_missing, row.schema_immature),
      correctness: qualityBlock(row.correct_passes, row.correct_failures, row.correct_unknown, row.correct_missing, row.correct_immature),
    },
    evaluationQuality: {
      pass: cohort.evaluationPasses,
      fail: cohort.evaluationFails,
      unknown: cohort.evaluationUnknown,
    },
    feedback: {
      mature: Number(row.task_passes) + Number(row.task_failures) + Number(row.task_unknown),
      missing: Number(row.task_missing),
      immature: Number(row.task_immature),
    },
  };
}

function cohortFrom(
  row: RawCounts,
  evaluation: readonly { deployment: string; side: 'canary' | 'baseline'; passes: number; fails: number; unknowns: number }[],
): CohortTotals {
  const matched = evaluation.filter((item) => item.side === row.cohort && item.deployment === row.cohort_deployment);
  const base = emptyCohort(row.cohort);
  return {
    ...base,
    assignments: Number(row.assignments),
    executions: Number(row.executions),
    errorRequests: Number(row.error_requests),
    timeoutRequests: Number(row.timeout_requests),
    incompleteStreamRequests: Number(row.incomplete_requests),
    retryRequests: Number(row.retry_requests),
    fallbackRequests: Number(row.fallback_requests),
    latencyP50Ms: numberOrNull(row.latency_p50),
    latencyP95Ms: numberOrNull(row.latency_p95),
    latencySamples: Number(row.latency_samples),
    costSum: Number(row.cost_sum),
    costSamples: Number(row.cost_samples),
    completedCostSum: Number(row.completed_cost_sum),
    completedRequests: Number(row.completed_requests),
    providerSuccesses: Number(row.provider_successes),
    schemaPasses: Number(row.schema_passes),
    schemaFailures: Number(row.schema_failures),
    schemaUnknown: Number(row.schema_unknown),
    schemaMature: Number(row.schema_passes) + Number(row.schema_failures) + Number(row.schema_unknown),
    schemaMissing: Number(row.schema_missing),
    schemaImmature: Number(row.schema_immature),
    taskSuccesses: Number(row.task_passes),
    taskFailures: Number(row.task_failures),
    taskUnknown: Number(row.task_unknown),
    taskMature: Number(row.task_passes) + Number(row.task_failures) + Number(row.task_unknown),
    taskMissing: Number(row.task_missing),
    taskImmature: Number(row.task_immature),
    correctnessSuccesses: Number(row.correct_passes),
    correctnessFailures: Number(row.correct_failures),
    correctnessUnknown: Number(row.correct_unknown),
    correctnessMature: Number(row.correct_passes) + Number(row.correct_failures) + Number(row.correct_unknown),
    correctnessMissing: Number(row.correct_missing),
    correctnessImmature: Number(row.correct_immature),
    evaluationPasses: matched.reduce((sum, item) => sum + Number(item.passes), 0),
    evaluationFails: matched.reduce((sum, item) => sum + Number(item.fails), 0),
    evaluationUnknown: matched.reduce((sum, item) => sum + Number(item.unknowns), 0),
  };
}

function qualityBlock(pass: number, fail: number, unknown: number, missing: number, immature: number) {
  const passes = Number(pass);
  const fails = Number(fail);
  const unknowns = Number(unknown);
  return {
    pass: passes,
    fail: fails,
    unknown: unknowns,
    mature: passes + fails + unknowns,
    missing: Number(missing),
    immature: Number(immature),
  };
}

const METRIC_CTES = `
WITH scoped AS (
  SELECT
    a.request_id,
    a.policy_version_id::text AS policy_version_id,
    a.cohort,
    a.cohort_deployment_id,
    cohort_dep.name AS cohort_deployment,
    executed_dep.name AS executed_deployment,
    COALESCE(rf.task_category, 'unknown') AS task_segment,
    pr.status AS request_status,
    (a.executed_deployment_id <> a.cohort_deployment_id) AS fell_back,
    (a.created_at + make_interval(secs => $3::int) <= statement_timestamp()) AS due
  FROM routing_canary_assignments a
  JOIN model_deployments cohort_dep
    ON cohort_dep.tenant_id = a.tenant_id AND cohort_dep.id = a.cohort_deployment_id
  JOIN model_deployments executed_dep
    ON executed_dep.tenant_id = a.tenant_id AND executed_dep.id = a.executed_deployment_id
  LEFT JOIN request_features rf ON rf.tenant_id = a.tenant_id AND rf.request_id = a.request_id
  LEFT JOIN proxy_requests pr ON pr.tenant_id = a.tenant_id AND pr.id = a.request_id
  WHERE a.rollout_id = $1::uuid
    AND a.created_at >= statement_timestamp() - make_interval(secs => $2::int)
),
attempts AS (
  SELECT
    ma.request_id,
    BOOL_OR(ma.status <> 'pending') AS executed,
    BOOL_OR(
      ma.deployment_id = s.cohort_deployment_id
      AND ma.failure_class = ANY(${sqlList(ERROR_CLASSES)})
    ) AS has_error,
    BOOL_OR(
      ma.deployment_id = s.cohort_deployment_id
      AND (ma.failure_class = ANY(${sqlList(TIMEOUT_CLASSES)}) OR ma.stream_status = 'timed_out')
    ) AS has_timeout,
    BOOL_OR(
      ma.deployment_id = s.cohort_deployment_id
      AND (ma.failure_class = 'stream_started' OR ma.stream_status = 'stream_truncated')
    ) AS has_incomplete,
    BOOL_OR(ma.deployment_id = s.cohort_deployment_id AND ma.trigger_reason = 'retry') AS has_retry,
    MAX(ma.duration_ms) AS duration_ms,
    COALESCE(SUM(ac.amount), 0) AS cost_sum,
    COUNT(ac.amount)::int AS cost_samples
  FROM model_attempts ma
  JOIN scoped s ON s.request_id = ma.request_id
  LEFT JOIN attempt_costs ac ON ac.tenant_id = ma.tenant_id AND ac.attempt_id = ma.id
  GROUP BY ma.request_id
),
feedback AS (
  SELECT
    f.request_id,
    f.metric,
    CASE WHEN COUNT(DISTINCT f.result) > 1 THEN 'unknown' ELSE MIN(f.result) END AS result,
    BOOL_OR(f.created_at + make_interval(secs => $3::int) <= statement_timestamp()) AS any_mature
  FROM routing_task_feedback f
  WHERE f.request_id IN (SELECT request_id FROM scoped)
    AND NOT EXISTS (
      SELECT 1 FROM routing_task_feedback newer
      WHERE newer.tenant_id = f.tenant_id AND newer.superseded_feedback_id = f.feedback_id
    )
  GROUP BY f.request_id, f.metric
)`;

function seriesSql(): string {
  return `${METRIC_CTES}
SELECT ${SELECT_COUNTS},
       s.policy_version_id, s.cohort, s.cohort_deployment, s.executed_deployment, s.task_segment
FROM scoped s
LEFT JOIN attempts att ON att.request_id = s.request_id
${FEEDBACK_JOINS}
GROUP BY s.policy_version_id, s.cohort, s.cohort_deployment, s.executed_deployment, s.task_segment
ORDER BY s.cohort, s.task_segment, s.executed_deployment`;
}

function cohortSql(): string {
  return `${METRIC_CTES}
SELECT ${SELECT_COUNTS},
       NULL::text AS policy_version_id, s.cohort,
       MIN(s.cohort_deployment) AS cohort_deployment,
       MIN(s.executed_deployment) AS executed_deployment,
       'all' AS task_segment
FROM scoped s
LEFT JOIN attempts att ON att.request_id = s.request_id
${FEEDBACK_JOINS}
GROUP BY s.cohort
ORDER BY s.cohort`;
}

const SELECT_COUNTS = `
  COUNT(*)::int AS assignments,
  COUNT(*) FILTER (WHERE COALESCE(att.executed, false))::int AS executions,
  COUNT(*) FILTER (WHERE COALESCE(att.has_error, false))::int AS error_requests,
  COUNT(*) FILTER (WHERE COALESCE(att.has_timeout, false))::int AS timeout_requests,
  COUNT(*) FILTER (WHERE COALESCE(att.has_incomplete, false))::int AS incomplete_requests,
  COUNT(*) FILTER (WHERE COALESCE(att.has_retry, false))::int AS retry_requests,
  COUNT(*) FILTER (WHERE s.fell_back AND COALESCE(att.executed, false))::int AS fallback_requests,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY att.duration_ms) AS latency_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY att.duration_ms) AS latency_p95,
  COUNT(att.duration_ms)::int AS latency_samples,
  COALESCE(SUM(att.cost_sum), 0)::text AS cost_sum,
  COALESCE(SUM(att.cost_samples), 0)::int AS cost_samples,
  COALESCE(SUM(att.cost_sum) FILTER (WHERE s.request_status = 'succeeded'), 0)::text AS completed_cost_sum,
  COUNT(*) FILTER (WHERE s.request_status = 'succeeded')::int AS completed_requests,
  COUNT(*) FILTER (WHERE s.request_status = 'succeeded')::int AS provider_successes,
  COUNT(*) FILTER (WHERE schema_fb.result = 'pass' AND schema_fb.any_mature)::int AS schema_passes,
  COUNT(*) FILTER (WHERE schema_fb.result = 'fail' AND schema_fb.any_mature)::int AS schema_failures,
  COUNT(*) FILTER (WHERE schema_fb.result = 'unknown' AND schema_fb.any_mature)::int AS schema_unknown,
  COUNT(*) FILTER (WHERE s.due AND COALESCE(att.executed, false) AND schema_fb.request_id IS NULL)::int AS schema_missing,
  COUNT(*) FILTER (WHERE NOT s.due OR (schema_fb.request_id IS NOT NULL AND NOT schema_fb.any_mature))::int AS schema_immature,
  COUNT(*) FILTER (WHERE task_fb.result = 'pass' AND task_fb.any_mature)::int AS task_passes,
  COUNT(*) FILTER (WHERE task_fb.result = 'fail' AND task_fb.any_mature)::int AS task_failures,
  COUNT(*) FILTER (WHERE task_fb.result = 'unknown' AND task_fb.any_mature)::int AS task_unknown,
  COUNT(*) FILTER (WHERE s.due AND COALESCE(att.executed, false) AND task_fb.request_id IS NULL)::int AS task_missing,
  COUNT(*) FILTER (WHERE NOT s.due OR (task_fb.request_id IS NOT NULL AND NOT task_fb.any_mature))::int AS task_immature,
  COUNT(*) FILTER (WHERE correct_fb.result = 'pass' AND correct_fb.any_mature)::int AS correct_passes,
  COUNT(*) FILTER (WHERE correct_fb.result = 'fail' AND correct_fb.any_mature)::int AS correct_failures,
  COUNT(*) FILTER (WHERE correct_fb.result = 'unknown' AND correct_fb.any_mature)::int AS correct_unknown,
  COUNT(*) FILTER (WHERE s.due AND COALESCE(att.executed, false) AND correct_fb.request_id IS NULL)::int AS correct_missing,
  COUNT(*) FILTER (WHERE NOT s.due OR (correct_fb.request_id IS NOT NULL AND NOT correct_fb.any_mature))::int AS correct_immature`;

const FEEDBACK_JOINS = `
LEFT JOIN feedback task_fb ON task_fb.request_id = s.request_id AND task_fb.metric = 'task_success'
LEFT JOIN feedback schema_fb ON schema_fb.request_id = s.request_id AND schema_fb.metric = 'schema_valid'
LEFT JOIN feedback correct_fb ON correct_fb.request_id = s.request_id AND correct_fb.metric = 'correctness'`;

function sqlList(values: readonly string[]): string {
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]::text[]`;
}

function parseRule(value: unknown): Omit<GuardrailRule, 'id'> {
  const record = objectBody(value, 'The policy body is invalid.');
  const allowed = new Set([
    'kind',
    'signal',
    'threshold',
    'margin',
    'minSamples',
    'windowSeconds',
    'maturitySeconds',
    'maxMissingFraction',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The policy body is invalid.');
  }
  if (typeof record.kind !== 'string' || !isGuardrailKind(record.kind)) {
    throw invalidRequest('kind', 'invalid_parameter', 'kind is invalid.');
  }
  if (typeof record.signal !== 'string' || !signalAllowed(record.kind, record.signal)) {
    throw invalidRequest('signal', 'invalid_parameter', 'signal is invalid.');
  }
  const thresholdMax = record.kind === 'latency' || record.kind === 'spending' || record.kind === 'capability' ? 1_000_000 : 1;
  return {
    kind: record.kind,
    signal: record.signal,
    threshold: decimalField(record.threshold, 'threshold', 0, thresholdMax),
    margin: record.margin === undefined ? CONSERVATIVE_DEFAULTS.margin : decimalField(record.margin, 'margin', 0, 1),
    minSamples:
      record.minSamples === undefined
        ? CONSERVATIVE_DEFAULTS.minSamples
        : integerField(record.minSamples, 'minSamples', 1, 100_000),
    windowSeconds:
      record.windowSeconds === undefined
        ? CONSERVATIVE_DEFAULTS.windowSeconds
        : integerField(record.windowSeconds, 'windowSeconds', 1, 2_592_000),
    maturitySeconds:
      record.maturitySeconds === undefined
        ? CONSERVATIVE_DEFAULTS.maturitySeconds
        : integerField(record.maturitySeconds, 'maturitySeconds', 0, 2_592_000),
    maxMissingFraction:
      record.maxMissingFraction === undefined
        ? CONSERVATIVE_DEFAULTS.maxMissingFraction
        : decimalField(record.maxMissingFraction, 'maxMissingFraction', 0, 1),
  };
}

type FeedbackRow = {
  id: string;
  request_id: string;
  feedback_id: string;
  source: string;
  metric: FeedbackWrite['metric'];
  result: FeedbackWrite['result'];
  validator_version: string;
  observed_at: Date;
  superseded_feedback_id: string | null;
  created_at: Date;
  request_hash: string;
};

const FEEDBACK_COLUMNS = `id::text AS id, request_id::text AS request_id, feedback_id, source, metric, result,
  validator_version, observed_at, superseded_feedback_id, created_at, request_hash`;

function feedbackView(row: FeedbackRow): FeedbackView {
  return {
    id: row.id,
    requestId: row.request_id,
    feedbackId: row.feedback_id,
    source: row.source,
    metric: row.metric,
    result: row.result,
    validatorVersion: row.validator_version,
    observedAt: row.observed_at.toISOString(),
    supersededFeedbackId: row.superseded_feedback_id,
    createdAt: row.created_at.toISOString(),
  };
}

type ViolationRow = {
  id: string;
  rollout_id: string;
  rule_id: string | null;
  trigger: 'operator' | 'guardrail';
  kind: string;
  signal: string;
  reason: string;
  epoch: number;
  evidence: Record<string, number | null>;
  created_at: Date;
};

function violationView(row: ViolationRow): ViolationView {
  return {
    id: row.id,
    rolloutId: row.rollout_id,
    ruleId: row.rule_id,
    trigger: row.trigger,
    kind: row.kind,
    signal: row.signal,
    reason: row.reason,
    epoch: Number(row.epoch),
    evidence: evidenceObject(row.evidence),
    createdAt: row.created_at.toISOString(),
  };
}

function evidenceObject(value: Record<string, number | null> | null): Record<string, number | null> {
  const evidence: Record<string, number | null> = {};
  if (value === null || typeof value !== 'object') return evidence;
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key)) continue;
    if (item === null) evidence[key] = null;
    else if (typeof item === 'number' && Number.isFinite(item)) evidence[key] = item;
  }
  return evidence;
}

function canonicalFeedback(write: FeedbackWrite): string {
  return JSON.stringify({
    requestId: write.requestId,
    feedbackId: write.feedbackId,
    source: write.source,
    metric: write.metric,
    result: write.result,
    validatorVersion: write.validatorVersion,
    observedAt: write.observedAt,
    supersededFeedbackId: write.supersededFeedbackId,
  });
}

function canonicalAttach(write: GuardrailAttach): string {
  return JSON.stringify({
    rolloutId: write.rolloutId,
    approvedSources: write.approvedSources,
    rules: write.rules,
  });
}

function objectBody(body: unknown, message: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', message);
  }
  return body as Record<string, unknown>;
}

function uuidField(value: unknown, param: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  return value.toLowerCase();
}

function tokenField(value: unknown, param: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  return value;
}

function integerField(value: unknown, param: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value;
}

function decimalField(value: unknown, param: string, min: number, max: number): number {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return numeric;
}

function timestampField(value: unknown): string {
  if (typeof value !== 'string' || value.length < 20 || value.length > 40) {
    throw invalidRequest('timestamp', 'invalid_parameter', 'timestamp is invalid.');
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw invalidRequest('timestamp', 'invalid_parameter', 'timestamp is invalid.');
  const now = Date.now();
  if (parsed > now + 5 * 60_000 || parsed < Date.parse('2020-01-01T00:00:00.000Z')) {
    throw invalidRequest('timestamp', 'invalid_parameter', 'timestamp is invalid.');
  }
  return new Date(parsed).toISOString();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function rate(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1_000_000) / 1_000_000;
}

function perRequest(amount: string, count: number): string | null {
  if (count <= 0) return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  return (value / count).toFixed(8);
}

function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 1_000) / 1_000 : null;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
