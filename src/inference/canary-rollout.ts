import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { assignCohort, generatedRoutingKey, routingKeyDigest, type CanaryCohort } from './canary-assignment.js';
import { invalidRequest, proxyError } from './errors.js';
import { routeForDeployment, type DeploymentCandidate, type ResolvedRoute } from './resolve.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONEY = /^(?:0|[1-9]\d{0,6})(?:\.\d{1,8})?$/;

export type RolloutWrite = {
  policyId: string;
  basisPoints: number;
  maxRequestCount: number;
  maxExpense: string;
  maxDurationSeconds: number;
  evidenceSnapshotId: string;
  criticalErrorThreshold: number;
};

export type RolloutView = {
  id: string;
  policyId: string;
  versionId: string;
  alias: 'auto';
  basisPoints: number;
  maxRequestCount: number;
  maxExpense: string;
  maxDurationSeconds: number;
  evidenceSnapshotId: string;
  baselineDeployment: string;
  challengerDeployment: string;
  criticalErrorThreshold: number;
  epoch: number;
  status: 'active' | 'stopped';
  stopReason: string | null;
  activatedAt: string;
  stoppedAt: string | null;
  canaryRequestCount: number;
  canaryExpense: string;
  criticalErrorCount: number;
};

export type CanaryAssignmentView = {
  requestId: string;
  rolloutId: string | null;
  policyVersionId: string | null;
  cohort: CanaryCohort;
  cohortDeployment: string;
  executedDeployment: string;
  routingKeyDigest: string | null;
  holdReason: string;
};

export type CanaryPlan = {
  route: ResolvedRoute;
  cohort: CanaryCohort;
  rolloutId: string | null;
  policyVersionId: string | null;
  cohortDeploymentId: string;
  routingKeyDigest: string | null;
  holdReason: string;
  record: boolean;
};

type RolloutRow = {
  id: string;
  policy_id: string;
  version_id: string;
  alias: 'auto';
  basis_points: number;
  max_request_count: number;
  max_expense: string;
  max_duration_seconds: number;
  evidence_snapshot_id: string;
  baseline_deployment_id: string;
  challenger_deployment_id: string;
  critical_error_threshold: number;
  epoch: number;
  status: 'active' | 'stopped';
  stop_reason: string | null;
  canary_request_count: number;
  canary_expense: string;
  critical_error_count: number;
  duration_elapsed: boolean;
  expense_reached: boolean;
  request_reached: boolean;
  errors_reached: boolean;
};

export function parseRolloutWrite(body: unknown): RolloutWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The rollout body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set([
    'policyId',
    'basisPoints',
    'maxRequestCount',
    'maxExpense',
    'maxDurationSeconds',
    'evidenceSnapshotId',
    'criticalErrorThreshold',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The rollout body is invalid.');
  }
  return {
    policyId: uuidField(record.policyId, 'policyId'),
    basisPoints: integerField(record.basisPoints, 'basisPoints', 0, 10_000),
    maxRequestCount: integerField(record.maxRequestCount, 'maxRequestCount', 1, 1_000_000),
    maxExpense: money(record.maxExpense),
    maxDurationSeconds: integerField(record.maxDurationSeconds, 'maxDurationSeconds', 1, 31_536_000),
    evidenceSnapshotId: uuidField(record.evidenceSnapshotId, 'evidenceSnapshotId'),
    criticalErrorThreshold: integerField(record.criticalErrorThreshold, 'criticalErrorThreshold', 1, 10_000),
  };
}

export function parseRolloutId(rolloutId: string): string {
  return uuidField(rolloutId, 'rollout_id');
}

export async function createRollout(
  client: PoolClient,
  tenantId: string,
  idempotencyKey: string,
  write: RolloutWrite,
): Promise<{ rollout: RolloutView; created: boolean }> {
  const requestHash = createHash('sha256').update(canonicalWrite(write)).digest('hex');
  const existing = await client.query<{ rollout_id: string; request_hash: string }>(
    `SELECT rollout_id::text AS rollout_id, request_hash
     FROM routing_rollout_events
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  const stored = existing.rows[0];
  if (stored !== undefined) {
    if (stored.request_hash !== requestHash) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return { rollout: await readRollout(client, stored.rollout_id), created: false };
  }
  const policy = await client.query<{
    status: string;
    version_id: string;
    baseline_deployment_id: string;
    candidate_deployment_ids: string[];
    task_segments: string[];
    alias_deployment_id: string | null;
  }>(
    `SELECT a.status, a.version_id::text AS version_id,
            v.baseline_deployment_id::text AS baseline_deployment_id,
            v.candidate_deployment_ids::text[] AS candidate_deployment_ids,
            v.task_segments,
            alias.deployment_id::text AS alias_deployment_id
     FROM routing_policy_activations a
     JOIN routing_policy_versions v ON v.tenant_id = a.tenant_id AND v.id = a.version_id
     LEFT JOIN model_aliases alias ON alias.tenant_id = a.tenant_id AND alias.alias = 'auto'
     WHERE a.policy_id = $1`,
    [write.policyId],
  );
  const current = policy.rows[0];
  if (current === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'policyId', 'The policy was not found.');
  }
  if (current.status !== 'shadow') {
    throw proxyError(409, 'invalid_request_error', 'policy_not_shadow', 'policyId', 'The policy is not an approved shadow policy.');
  }
  if (current.alias_deployment_id !== current.baseline_deployment_id) {
    throw proxyError(409, 'invalid_request_error', 'baseline_mismatch', 'policyId', 'The alias baseline does not match the policy.');
  }
  const evidence = await loadEvidence(client, write.evidenceSnapshotId);
  if (evidence === null) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'evidenceSnapshotId', 'The evidence snapshot was not found.');
  }
  if (evidence.status !== 'qualified') {
    throw proxyError(409, 'invalid_request_error', 'evidence_not_qualified', 'evidenceSnapshotId', 'The evidence snapshot is not qualified.');
  }
  if (!evidence.fresh) {
    throw proxyError(409, 'invalid_request_error', 'evidence_stale', 'evidenceSnapshotId', 'The evidence snapshot is stale.');
  }
  const candidates = textList(current.candidate_deployment_ids);
  if (!candidates.includes(evidence.candidateDeploymentId) || evidence.candidateDeploymentId === current.baseline_deployment_id) {
    throw proxyError(409, 'invalid_request_error', 'challenger_not_in_policy', 'evidenceSnapshotId', 'The challenger is not a policy candidate.');
  }
  if (!textList(current.task_segments).includes(evidence.taskCategory)) {
    throw proxyError(409, 'invalid_request_error', 'evidence_not_qualified', 'evidenceSnapshotId', 'The evidence segment is not in the policy.');
  }
  const deployment = await loadDeployment(client, evidence.candidateDeploymentId);
  if (
    deployment === null
    || !deployment.enabled
    || !deployment.connectionEnabled
    || deployment.validationStatus !== 'validated_live'
    || deployment.upstreamModel !== evidence.modelVersion
    || deployment.configVersion !== evidence.configVersion
  ) {
    throw proxyError(409, 'invalid_request_error', 'deployment_unvalidated', 'evidenceSnapshotId', 'The challenger deployment is not validated.');
  }
  await client.query('SAVEPOINT rollout_create');
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO routing_rollouts (
         tenant_id, policy_id, version_id, alias, basis_points, max_request_count, max_expense,
         max_duration_seconds, evidence_snapshot_id, baseline_deployment_id, challenger_deployment_id,
         critical_error_threshold, epoch, status, idempotency_key, request_hash
       ) VALUES (
         $1, $2, $3, 'auto', $4, $5, $6::numeric, $7, $8, $9, $10, $11, 1, 'active', $12, $13
       )
       RETURNING id::text AS id`,
      [
        tenantId,
        write.policyId,
        current.version_id,
        write.basisPoints,
        write.maxRequestCount,
        write.maxExpense,
        write.maxDurationSeconds,
        write.evidenceSnapshotId,
        current.baseline_deployment_id,
        evidence.candidateDeploymentId,
        write.criticalErrorThreshold,
        idempotencyKey,
        requestHash,
      ],
    );
    const rolloutId = inserted.rows[0]?.id;
    if (rolloutId === undefined) throw new Error('rollout was not stored');
    await insertEvent(client, {
      tenantId,
      rolloutId,
      action: 'activate',
      epoch: 1,
      stopReason: null,
      idempotencyKey,
      requestHash,
    });
    await client.query('RELEASE SAVEPOINT rollout_create');
    return { rollout: await readRollout(client, rolloutId), created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    await client.query('ROLLBACK TO SAVEPOINT rollout_create');
    await client.query('RELEASE SAVEPOINT rollout_create');
    const raced = await client.query<{ rollout_id: string; request_hash: string }>(
      `SELECT rollout_id::text AS rollout_id, request_hash
       FROM routing_rollout_events
       WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (raced.rows[0]?.request_hash === requestHash) {
      return { rollout: await readRollout(client, raced.rows[0].rollout_id), created: false };
    }
    if (raced.rows.length > 0) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'policyId', 'Another canary is already active.');
  }
}

export async function readRollout(client: PoolClient, rolloutId: string): Promise<RolloutView> {
  const result = await client.query<{
    id: string;
    policy_id: string;
    version_id: string;
    basis_points: number;
    max_request_count: number;
    max_expense: string;
    max_duration_seconds: number;
    evidence_snapshot_id: string;
    baseline_deployment: string;
    challenger_deployment: string;
    critical_error_threshold: number;
    epoch: number;
    status: 'active' | 'stopped';
    stop_reason: string | null;
    activated_at: Date;
    stopped_at: Date | null;
    canary_request_count: number;
    canary_expense: string;
    critical_error_count: number;
  }>(
    `SELECT r.id::text AS id, r.policy_id::text AS policy_id, r.version_id::text AS version_id,
            r.basis_points, r.max_request_count, r.max_expense::text AS max_expense, r.max_duration_seconds,
            r.evidence_snapshot_id::text AS evidence_snapshot_id,
            b.name AS baseline_deployment, c.name AS challenger_deployment,
            r.critical_error_threshold, r.epoch, r.status, r.stop_reason, r.activated_at, r.stopped_at,
            r.canary_request_count, r.canary_expense::text AS canary_expense, r.critical_error_count
     FROM routing_rollouts r
     JOIN model_deployments b ON b.tenant_id = r.tenant_id AND b.id = r.baseline_deployment_id
     JOIN model_deployments c ON c.tenant_id = r.tenant_id AND c.id = r.challenger_deployment_id
     WHERE r.id = $1`,
    [rolloutId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rollout_id', 'The rollout was not found.');
  }
  return {
    id: row.id,
    policyId: row.policy_id,
    versionId: row.version_id,
    alias: 'auto',
    basisPoints: Number(row.basis_points),
    maxRequestCount: Number(row.max_request_count),
    maxExpense: fixedDecimal(row.max_expense, 8),
    maxDurationSeconds: Number(row.max_duration_seconds),
    evidenceSnapshotId: row.evidence_snapshot_id,
    baselineDeployment: row.baseline_deployment,
    challengerDeployment: row.challenger_deployment,
    criticalErrorThreshold: Number(row.critical_error_threshold),
    epoch: Number(row.epoch),
    status: row.status,
    stopReason: row.stop_reason,
    activatedAt: row.activated_at.toISOString(),
    stoppedAt: row.stopped_at === null ? null : row.stopped_at.toISOString(),
    canaryRequestCount: Number(row.canary_request_count),
    canaryExpense: fixedDecimal(row.canary_expense, 8),
    criticalErrorCount: Number(row.critical_error_count),
  };
}

export async function stopRollout(
  client: PoolClient,
  tenantId: string,
  rolloutId: string,
  idempotencyKey: string,
  expectedEpoch: number,
): Promise<RolloutView> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ rolloutId, action: 'stop', expectedEpoch }))
    .digest('hex');
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
    return readRollout(client, rolloutId);
  }
  const current = await client.query<{ epoch: number; status: 'active' | 'stopped' }>(
    `SELECT epoch, status FROM routing_rollouts WHERE id = $1`,
    [rolloutId],
  );
  const row = current.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rollout_id', 'The rollout was not found.');
  }
  if (Number(row.epoch) !== expectedEpoch) {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The rollout epoch is stale.');
  }
  if (row.status !== 'active') {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The rollout epoch is stale.');
  }
  const updated = await client.query<{ epoch: number }>(
    `UPDATE routing_rollouts
     SET status = 'stopped', stop_reason = 'manual', stopped_at = statement_timestamp(),
         epoch = epoch + 1, updated_at = statement_timestamp()
     WHERE id = $1 AND epoch = $2 AND status = 'active'
     RETURNING epoch`,
    [rolloutId, expectedEpoch],
  );
  const epoch = updated.rows[0]?.epoch;
  if (epoch === undefined) {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The rollout epoch is stale.');
  }
  try {
    await insertEvent(client, {
      tenantId,
      rolloutId,
      action: 'stop',
      epoch: Number(epoch),
      stopReason: 'manual',
      idempotencyKey,
      requestHash,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const raced = await client.query<{ request_hash: string }>(
      `SELECT request_hash FROM routing_rollout_events WHERE idempotency_key = $1 AND rollout_id = $2`,
      [idempotencyKey, rolloutId],
    );
    if (raced.rows[0]?.request_hash === requestHash) return readRollout(client, rolloutId);
    throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
  }
  return readRollout(client, rolloutId);
}

export async function readCanaryAssignment(client: PoolClient, requestId: string): Promise<CanaryAssignmentView | null> {
  const result = await client.query<{
    request_id: string;
    rollout_id: string | null;
    policy_version_id: string | null;
    cohort: CanaryCohort;
    cohort_deployment: string;
    executed_deployment: string;
    routing_key_digest: string | null;
    hold_reason: string;
  }>(
    `SELECT a.request_id::text AS request_id, a.rollout_id::text AS rollout_id,
            a.policy_version_id::text AS policy_version_id, a.cohort,
            cohort.name AS cohort_deployment, executed.name AS executed_deployment,
            a.routing_key_digest, a.hold_reason
     FROM routing_canary_assignments a
     JOIN model_deployments cohort ON cohort.tenant_id = a.tenant_id AND cohort.id = a.cohort_deployment_id
     JOIN model_deployments executed ON executed.tenant_id = a.tenant_id AND executed.id = a.executed_deployment_id
     WHERE a.request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    requestId: row.request_id,
    rolloutId: row.rollout_id,
    policyVersionId: row.policy_version_id,
    cohort: row.cohort,
    cohortDeployment: row.cohort_deployment,
    executedDeployment: row.executed_deployment,
    routingKeyDigest: row.routing_key_digest,
    holdReason: row.hold_reason,
  };
}

export async function pinCanary(input: {
  pool: Pool;
  logger: Logger;
  tenantId: string;
  route: ResolvedRoute;
  routingKey: string | null;
  deployments: readonly DeploymentCandidate[];
}): Promise<CanaryPlan> {
  if (input.route.routedByAlias !== true || input.route.requestedModel !== 'auto') {
    return {
      route: input.route,
      cohort: 'baseline',
      rolloutId: null,
      policyVersionId: null,
      cohortDeploymentId: input.route.deploymentId,
      routingKeyDigest: null,
      holdReason: 'not_auto',
      record: false,
    };
  }
  try {
    return await withTenant(input.pool, input.tenantId, (client) => planOnClient(client, input.tenantId, input.route, input.routingKey, input.deployments));
  } catch (error) {
    input.logger.error('canary safety state was not read', { message: errorMessage(error) });
    return {
      route: input.route,
      cohort: 'baseline',
      rolloutId: null,
      policyVersionId: null,
      cohortDeploymentId: input.route.deploymentId,
      routingKeyDigest: null,
      holdReason: 'safety_unreadable',
      record: true,
    };
  }
}

export async function recordCanaryAssignment(
  client: PoolClient,
  tenantId: string,
  requestId: string,
  plan: CanaryPlan,
): Promise<void> {
  if (!plan.record) return;
  await client.query(
    `INSERT INTO routing_canary_assignments (
       tenant_id, request_id, rollout_id, policy_version_id, cohort,
       cohort_deployment_id, executed_deployment_id, routing_key_digest, hold_reason
     ) VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8)`,
    [
      tenantId,
      requestId,
      plan.rolloutId,
      plan.policyVersionId,
      plan.cohort,
      plan.cohortDeploymentId,
      plan.routingKeyDigest,
      plan.holdReason,
    ],
  );
}

export async function reconcileCanary(pool: Pool, logger: Logger, tenantId: string, requestId: string): Promise<void> {
  if (requestId === '') return;
  try {
    await withTenant(pool, tenantId, async (client) => {
      const claimed = await client.query<{
        rollout_id: string | null;
        cohort: CanaryCohort;
        cohort_deployment_id: string;
      }>(
        `UPDATE routing_canary_assignments AS assignment
         SET executed_deployment_id = COALESCE((
               SELECT attempt.deployment_id
               FROM model_attempts AS attempt
               WHERE attempt.tenant_id = assignment.tenant_id
                 AND attempt.request_id = assignment.request_id
               ORDER BY attempt.attempt_ordinal DESC
               LIMIT 1
             ), assignment.executed_deployment_id),
             reconciled = true
         WHERE assignment.request_id = $1
           AND assignment.reconciled = false
         RETURNING rollout_id::text AS rollout_id, cohort,
                   cohort_deployment_id::text AS cohort_deployment_id`,
        [requestId],
      );
      const row = claimed.rows[0];
      if (row === undefined || row.cohort !== 'canary' || row.rollout_id === null) return;
      const totals = await client.query<{ expense: string; critical: number }>(
        `SELECT COALESCE(sum(cost.amount), 0)::text AS expense,
                count(*) FILTER (
                  WHERE attempt.failure_class IN ('upstream_error', 'unavailable', 'connection_failure', 'ambiguous_network')
                )::int AS critical
         FROM model_attempts AS attempt
         LEFT JOIN attempt_costs AS cost
           ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
         WHERE attempt.request_id = $1
           AND attempt.deployment_id = $2`,
        [requestId, row.cohort_deployment_id],
      );
      const expense = totals.rows[0]?.expense ?? '0';
      const critical = Number(totals.rows[0]?.critical ?? 0);
      await client.query(
        `UPDATE routing_rollouts
         SET canary_expense = canary_expense + $2::numeric,
             critical_error_count = critical_error_count + $3,
             updated_at = statement_timestamp(),
             status = CASE
               WHEN critical_error_count + $3 >= critical_error_threshold THEN 'stopped'
               WHEN canary_expense + $2::numeric >= max_expense THEN 'stopped'
               ELSE status
             END,
             stop_reason = CASE
               WHEN critical_error_count + $3 >= critical_error_threshold THEN 'critical_errors'
               WHEN canary_expense + $2::numeric >= max_expense THEN 'expense_cap'
               ELSE stop_reason
             END,
             stopped_at = CASE
               WHEN critical_error_count + $3 >= critical_error_threshold
                 OR canary_expense + $2::numeric >= max_expense
               THEN statement_timestamp()
               ELSE stopped_at
             END,
             epoch = CASE
               WHEN critical_error_count + $3 >= critical_error_threshold
                 OR canary_expense + $2::numeric >= max_expense
               THEN epoch + 1
               ELSE epoch
             END
         WHERE id = $1 AND status = 'active'`,
        [row.rollout_id, expense, critical],
      );
    });
  } catch (error) {
    logger.error('canary result was not recorded', { message: errorMessage(error) });
  }
}

async function planOnClient(
  client: PoolClient,
  tenantId: string,
  route: ResolvedRoute,
  routingKey: string | null,
  deployments: readonly DeploymentCandidate[],
): Promise<CanaryPlan> {
  const loaded = await client.query<RolloutRow>(
    `SELECT id::text AS id, policy_id::text AS policy_id, version_id::text AS version_id, alias,
            basis_points, max_request_count, max_expense::text AS max_expense, max_duration_seconds,
            evidence_snapshot_id::text AS evidence_snapshot_id,
            baseline_deployment_id::text AS baseline_deployment_id,
            challenger_deployment_id::text AS challenger_deployment_id,
            critical_error_threshold, epoch, status, stop_reason,
            canary_request_count, canary_expense::text AS canary_expense, critical_error_count,
            (activated_at + (max_duration_seconds * interval '1 second') <= statement_timestamp()) AS duration_elapsed,
            (canary_expense >= max_expense) AS expense_reached,
            (canary_request_count >= max_request_count) AS request_reached,
            (critical_error_count >= critical_error_threshold) AS errors_reached
     FROM routing_rollouts
     WHERE alias = 'auto' AND status = 'active'
     FOR UPDATE`,
  );
  const rollout = loaded.rows[0];
  if (rollout === undefined) {
    return held(route, null, route.deploymentId, null, null, 'no_rollout', false);
  }
  const hold = (reason: string, deploymentId = route.deploymentId): CanaryPlan =>
    held(route, rollout.id, deploymentId, rollout.version_id, null, reason, true);
  if (route.deploymentId !== rollout.baseline_deployment_id) return hold('baseline_changed');
  const policy = await client.query<{ status: string; task_segments: string[] }>(
    `SELECT a.status, v.task_segments
     FROM routing_policy_activations a
     JOIN routing_policy_versions v ON v.tenant_id = a.tenant_id AND v.id = a.version_id
     WHERE a.policy_id = $1 AND a.version_id = $2`,
    [rollout.policy_id, rollout.version_id],
  );
  const policyRow = policy.rows[0];
  if (policyRow === undefined || policyRow.status !== 'shadow') {
    await safetyStop(client, rollout, 'policy_disabled');
    return hold('policy_disabled');
  }
  const evidence = await loadEvidence(client, rollout.evidence_snapshot_id);
  if (
    evidence === null
    || evidence.status !== 'qualified'
    || evidence.candidateDeploymentId !== rollout.challenger_deployment_id
    || !textList(policyRow.task_segments).includes(evidence.taskCategory)
  ) {
    await safetyStop(client, rollout, 'evidence_invalid');
    return hold('evidence_invalid');
  }
  const newer = await client.query<{ status: string }>(
    `SELECT a.status
     FROM evidence_snapshots s
     JOIN evidence_candidate_assessments a ON a.tenant_id = s.tenant_id AND a.snapshot_id = s.id
     WHERE s.profile_version_id = $1
       AND (s.created_at, s.id) > ($2::timestamptz, $3::uuid)
     ORDER BY s.created_at DESC, s.id DESC
     LIMIT 1`,
    [evidence.profileVersionId, evidence.createdAt, evidence.snapshotId],
  );
  if (newer.rows[0] !== undefined && newer.rows[0].status !== 'qualified') {
    await safetyStop(client, rollout, 'evidence_invalid');
    return hold('evidence_invalid');
  }
  if (!evidence.fresh) {
    await safetyStop(client, rollout, 'evidence_stale');
    return hold('evidence_stale');
  }
  const challenger = deployments.find((item) => item.id === rollout.challenger_deployment_id);
  if (
    challenger === undefined
    || challenger.upstreamModel !== evidence.modelVersion
    || challenger.configVersion !== evidence.configVersion
  ) {
    await safetyStop(client, rollout, 'evidence_invalid');
    return hold('evidence_invalid');
  }
  if (rollout.duration_elapsed) {
    await safetyStop(client, rollout, 'duration_limit');
    return hold('duration_limit');
  }
  if (rollout.expense_reached) {
    await safetyStop(client, rollout, 'expense_cap');
    return hold('expense_cap');
  }
  if (rollout.request_reached) {
    await safetyStop(client, rollout, 'request_cap');
    return hold('request_cap');
  }
  if (rollout.errors_reached) {
    await safetyStop(client, rollout, 'critical_errors');
    return hold('critical_errors');
  }
  if (!challenger.enabled || !challenger.connectionEnabled || challenger.validationStatus !== 'validated_live') {
    return hold('deployment_unvalidated');
  }
  const fallback = route.fallbackPolicy ?? null;
  if (fallback !== null && fallback.enabled) {
    if (!fallback.allowedProviders.includes(challenger.provider)) return hold('provider_permission');
    if (challenger.dataCollection === null || challenger.dataCollection !== fallback.dataCollection) return hold('data_policy');
    if (fallback.allowedRegions.length > 0) {
      if (challenger.location === null || !fallback.allowedRegions.includes(challenger.location)) return hold('region_policy');
    }
  }
  const key = routingKey ?? generatedRoutingKey();
  const digest = routingKeyDigest(key);
  const cohort = assignCohort({
    tenantId,
    alias: 'auto',
    policyVersionId: rollout.version_id,
    routingKey: key,
    basisPoints: Number(rollout.basis_points),
  });
  if (cohort === 'baseline') {
    return held(route, rollout.id, route.deploymentId, rollout.version_id, digest, 'share_baseline', true);
  }
  const claimed = await client.query(
    `UPDATE routing_rollouts
     SET canary_request_count = canary_request_count + 1, updated_at = statement_timestamp()
     WHERE id = $1 AND status = 'active' AND canary_request_count < max_request_count
     RETURNING id`,
    [rollout.id],
  );
  if ((claimed.rowCount ?? 0) !== 1) {
    await safetyStop(client, rollout, 'request_cap');
    return hold('request_cap');
  }
  const pinned = routeForDeployment(route.requestedModel, challenger, true, route.fallbackPolicy ?? null);
  return {
    route: pinned,
    cohort: 'canary',
    rolloutId: rollout.id,
    policyVersionId: rollout.version_id,
    cohortDeploymentId: challenger.id,
    routingKeyDigest: digest,
    holdReason: 'assigned',
    record: true,
  };
}

async function safetyStop(client: PoolClient, rollout: RolloutRow, reason: string): Promise<void> {
  const updated = await client.query<{ epoch: number }>(
    `UPDATE routing_rollouts
     SET status = 'stopped', stop_reason = $3, stopped_at = statement_timestamp(),
         epoch = epoch + 1, updated_at = statement_timestamp()
     WHERE id = $1 AND epoch = $2 AND status = 'active'
     RETURNING epoch`,
    [rollout.id, Number(rollout.epoch), reason],
  );
  const epoch = updated.rows[0]?.epoch;
  if (epoch === undefined) return;
  const idempotencyKey = `safety:${rollout.id}:${Number(rollout.epoch)}:${reason}`.slice(0, 200);
  const requestHash = createHash('sha256').update(idempotencyKey).digest('hex');
  await insertEvent(client, {
    tenantId: '',
    rolloutId: rollout.id,
    action: 'stop',
    epoch: Number(epoch),
    stopReason: reason,
    idempotencyKey,
    requestHash,
  }).catch((error: unknown) => {
    if (!isUniqueViolation(error)) throw error;
  });
}

async function insertEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    rolloutId: string;
    action: 'activate' | 'stop';
    epoch: number;
    stopReason: string | null;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO routing_rollout_events (
       tenant_id, rollout_id, action, epoch, stop_reason, idempotency_key, request_hash
     )
     SELECT r.tenant_id, r.id, $3, $4, $5, $6, $7
     FROM routing_rollouts r
     WHERE r.id = $2
       AND r.tenant_id::text = COALESCE(NULLIF($1::text, ''), r.tenant_id::text)`,
    [input.tenantId, input.rolloutId, input.action, input.epoch, input.stopReason, input.idempotencyKey, input.requestHash],
  );
}

type EvidenceRow = {
  snapshotId: string;
  profileVersionId: string;
  createdAt: Date;
  status: string;
  candidateDeploymentId: string;
  taskCategory: string;
  modelVersion: string;
  configVersion: number;
  fresh: boolean;
};

async function loadEvidence(client: PoolClient, snapshotId: string): Promise<EvidenceRow | null> {
  const result = await client.query<{
    snapshot_id: string;
    profile_version_id: string;
    created_at: Date;
    status: string;
    candidate_deployment_id: string;
    task_category: string;
    model_version: string;
    deployment_config_version: number;
    fresh: boolean;
  }>(
    `SELECT s.id::text AS snapshot_id, s.profile_version_id::text AS profile_version_id, s.created_at,
            a.status, v.candidate_deployment_id::text AS candidate_deployment_id, v.task_category,
            v.model_version, v.deployment_config_version,
            (s.created_at + (v.freshness_seconds * interval '1 second') > statement_timestamp()) AS fresh
     FROM evidence_snapshots s
     JOIN evidence_candidate_assessments a ON a.tenant_id = s.tenant_id AND a.snapshot_id = s.id
     JOIN qualification_profile_versions v ON v.tenant_id = s.tenant_id AND v.id = s.profile_version_id
     WHERE s.id = $1`,
    [snapshotId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    snapshotId: row.snapshot_id,
    profileVersionId: row.profile_version_id,
    createdAt: row.created_at,
    status: row.status,
    candidateDeploymentId: row.candidate_deployment_id,
    taskCategory: row.task_category,
    modelVersion: row.model_version,
    configVersion: Number(row.deployment_config_version),
    fresh: row.fresh,
  };
}

async function loadDeployment(
  client: PoolClient,
  deploymentId: string,
): Promise<{ enabled: boolean; connectionEnabled: boolean; validationStatus: string; upstreamModel: string; configVersion: number } | null> {
  const result = await client.query<{
    enabled: boolean;
    connection_enabled: boolean;
    validation_status: string;
    upstream_model: string;
    config_version: number;
  }>(
    `SELECT d.enabled, c.enabled AS connection_enabled, d.validation_status, d.upstream_model, d.config_version
     FROM model_deployments d
     JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE d.id = $1`,
    [deploymentId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    enabled: row.enabled,
    connectionEnabled: row.connection_enabled,
    validationStatus: row.validation_status,
    upstreamModel: row.upstream_model,
    configVersion: Number(row.config_version),
  };
}

function held(
  route: ResolvedRoute,
  rolloutId: string | null,
  cohortDeploymentId: string,
  policyVersionId: string | null,
  routingKeyDigestValue: string | null,
  holdReason: string,
  record: boolean,
): CanaryPlan {
  return {
    route,
    cohort: 'baseline',
    rolloutId,
    policyVersionId,
    cohortDeploymentId,
    routingKeyDigest: routingKeyDigestValue,
    holdReason,
    record,
  };
}

function canonicalWrite(write: RolloutWrite): string {
  return JSON.stringify({
    policyId: write.policyId,
    basisPoints: write.basisPoints,
    maxRequestCount: write.maxRequestCount,
    maxExpense: write.maxExpense,
    maxDurationSeconds: write.maxDurationSeconds,
    evidenceSnapshotId: write.evidenceSnapshotId,
    criticalErrorThreshold: write.criticalErrorThreshold,
  });
}

function uuidField(value: unknown, param: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value.toLowerCase();
}

function integerField(value: unknown, param: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value;
}

function money(value: unknown): string {
  if (typeof value !== 'string' || !MONEY.test(value)) {
    throw invalidRequest('maxExpense', 'invalid_parameter', 'maxExpense is invalid.');
  }
  const amount = Number(value);
  if (!(amount > 0) || amount > 1_000_000) {
    throw invalidRequest('maxExpense', 'invalid_parameter', 'maxExpense is invalid.');
  }
  return amount.toFixed(8);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    if (value.length === 2) return [];
    return value.slice(1, -1).split(',');
  }
  return [];
}

function fixedDecimal(value: string, places: number): string {
  const [whole, fraction = ''] = value.split('.');
  return `${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown';
}
