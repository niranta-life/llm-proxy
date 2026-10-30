import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { invalidRequest, proxyError, ProxyError } from './errors.js';
import { evaluatePromotionGates, RELIABILITY_TARGET, type PromotionFacts } from './promotion-gate.js';
import { knownAttemptCost, medianStored } from './shadow-rank.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';

export const DEFAULT_STAGES = [100, 500, 2500, 5000, 10000] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RATE = /^(?:0\.\d{5}|1\.00000)$/;

export type PromotionActor = 'operator' | 'automatic';

export type PromoteWrite = {
  expectedEpoch: number;
  taskSegment: TaskCategory;
  stages: number[];
  enableSelection: boolean;
};

export type AutomaticPolicyWrite = {
  enabled: boolean;
  approvedCandidateIds: string[];
  qualityMinPassRate: string;
  minValidPairs: number;
  noninferiorityMargin: string;
  maxBasisPoints: number;
  requireGuardrails: boolean;
  rollbackVerified: boolean;
};

export type PromoteCommand =
  | { kind: 'promote'; write: PromoteWrite }
  | { kind: 'automatic'; policy: AutomaticPolicyWrite }
  | { kind: 'reject'; proposalId: string };

export type PromotionFloor = {
  qualityMinPassRate: number;
  minValidPairs: number;
  noninferiorityMargin: number;
};

export type PromotionEventView = {
  action: 'promote' | 'advance' | 'rollback' | 'reject';
  actor: PromotionActor;
  activationEpoch: number;
  basisPoints: number;
  policyVersionId: string;
  previousPolicyVersionId: string | null;
  rollbackDeployment: string;
};

export type PromotionView = {
  id: string;
  rolloutId: string;
  policyId: string;
  policyVersionId: string;
  previousPolicyVersionId: string | null;
  rollbackDeployment: string;
  activationEpoch: number;
  basisPoints: number;
  stages: number[];
  stageIndex: number;
  taskSegment: TaskCategory;
  selectionEnabled: boolean;
  status: 'serving' | 'rolled_back';
  actor: PromotionActor;
  events: PromotionEventView[];
};

export type ProposalView = {
  id: string;
  evidenceSnapshotId: string;
  taskSegment: string;
  candidateDeployment: string;
  changeKind: 'quality' | 'cost' | 'latency' | 'candidate' | 'version';
  gateName: string;
  status: 'open' | 'rejected' | 'accepted';
  requiresShadow: true;
  requiresCanary: true;
};

export type AutomaticPolicyView = {
  enabled: boolean;
  approvedCandidateIds: string[];
  qualityMinPassRate: string;
  minValidPairs: number;
  noninferiorityMargin: string;
  maxBasisPoints: number;
  requireGuardrails: boolean;
  rollbackVerified: boolean;
};

export type PolicyPromotionAttachment = {
  promotion: PromotionView | null;
  proposals: ProposalView[];
  automaticPromotion: AutomaticPolicyView | null;
};

export type DecisionSelectionView = {
  promotion: {
    id: string;
    policyVersionId: string;
    activationEpoch: number;
    status: 'serving' | 'rolled_back';
  } | null;
  selection: {
    reason: string;
    taskSegment: string;
    baselineDeployment: string;
    selectedDeployment: string;
    expectedCost: string | null;
  } | null;
};

type RolloutGateRow = {
  id: string;
  policy_id: string;
  version_id: string;
  epoch: number;
  status: string;
  evidence_snapshot_id: string;
  baseline_deployment_id: string;
  challenger_deployment_id: string;
  critical_error_count: number;
  quality_min_pass_rate: string;
  quality_min_valid_pairs: number;
  max_cost_per_request: string;
  max_latency_ms: number;
  task_segments: string[];
  candidate_deployment_ids: string[];
  activation_status: string;
  evidence_status: string;
  reason_codes: string[];
  matched_pairs: number;
  wilson_lower: string | null;
  difference_lower: string | null;
  evidence_fresh: boolean;
  profile_task: string;
  profile_candidate_id: string;
  model_version: string;
  profile_config_version: number;
  min_samples: number;
  noninferiority_margin: string;
  upstream_model: string;
  config_version: number;
  challenger_enabled: boolean;
  challenger_connection_enabled: boolean;
  challenger_validated: string;
  challenger_provider: string;
  challenger_location: string | null;
  challenger_data_collection: 'allow' | 'deny' | null;
  fallback_enabled: boolean | null;
  allowed_providers: string[] | null;
  allowed_regions: string[] | null;
  fallback_data_collection: 'allow' | 'deny' | null;
  budget_mode: string | null;
  monthly_amount: string | null;
  canary_samples: number;
  canary_failed: number;
  latency_p95: string | null;
  canary_cost: string | null;
  baseline_cost: string | null;
  violation_count: number;
};

export function parsePromoteBody(body: unknown): PromoteCommand {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The promotion body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === 'proposalId') {
    if (typeof record.proposalId !== 'string' || !UUID.test(record.proposalId)) {
      throw invalidRequest('proposalId', 'invalid_parameter', 'The proposal id is invalid.');
    }
    return { kind: 'reject', proposalId: record.proposalId.toLowerCase() };
  }
  if (keys.length === 1 && keys[0] === 'automaticPolicy') {
    return { kind: 'automatic', policy: parseAutomaticPolicy(record.automaticPolicy) };
  }
  const allowed = new Set(['expectedEpoch', 'taskSegment', 'stages', 'enableSelection']);
  for (const key of keys) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The promotion body is invalid.');
  }
  if (typeof record.taskSegment !== 'string' || !isTaskCategory(record.taskSegment)) {
    throw invalidRequest('taskSegment', 'invalid_parameter', 'The task segment is invalid.');
  }
  const enableSelection = record.enableSelection === undefined ? false : record.enableSelection;
  if (typeof enableSelection !== 'boolean') {
    throw invalidRequest('enableSelection', 'invalid_parameter', 'The selection flag is invalid.');
  }
  return {
    kind: 'promote',
    write: {
      expectedEpoch: integerField(record.expectedEpoch, 'expectedEpoch', 1, 1_000_000),
      taskSegment: record.taskSegment,
      stages: parseStages(record.stages),
      enableSelection,
    },
  };
}

export async function promoteRollout(
  client: PoolClient,
  tenantId: string,
  rolloutId: string,
  idempotencyKey: string,
  write: PromoteWrite,
  actor: PromotionActor,
  floor: PromotionFloor | null,
): Promise<{ promotion: PromotionView; created: boolean }> {
  const requestHash = sha256(JSON.stringify({
    rolloutId,
    kind: 'promote',
    expectedEpoch: write.expectedEpoch,
    taskSegment: write.taskSegment,
    stages: write.stages,
    enableSelection: write.enableSelection,
    actor,
  }));
  const replay = await readEvent(client, idempotencyKey);
  if (replay !== null) {
    if (
      replay.request_hash !== requestHash
      || replay.rollout_id !== rolloutId
      || (replay.action !== 'promote' && replay.action !== 'advance')
      || replay.promotion_id === null
    ) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    return { promotion: await readPromotion(client, replay.promotion_id), created: false };
  }
  const rollout = await lockRollout(client, rolloutId);
  if (rollout.activation_status !== 'shadow') {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'status', 'The policy is not in shadow.');
  }
  if (!textList(rollout.task_segments).includes(write.taskSegment)) {
    throw invalidRequest('taskSegment', 'invalid_parameter', 'The task segment is not in the policy.');
  }
  if (rollout.profile_task !== write.taskSegment) {
    throw invalidRequest('taskSegment', 'invalid_parameter', 'The task segment does not match the evidence.');
  }
  const facts = factsFrom(rollout, floor);
  const gate = evaluatePromotionGates(facts);
  if (!gate.pass) {
    throw proxyError(409, 'invalid_request_error', 'promotion_rejected', gate.gate, 'The promotion gate failed.');
  }
  const serving = await lockServing(client, rolloutId);
  if (serving === null) {
    if (write.expectedEpoch !== Number(rollout.epoch)) {
      throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The activation epoch is stale.');
    }
    return { promotion: await insertPromotion(client, tenantId, rollout, write, actor, requestHash, idempotencyKey), created: true };
  }
  if (write.expectedEpoch !== Number(serving.activation_epoch)) {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The activation epoch is stale.');
  }
  if (serving.task_segment !== write.taskSegment) {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'taskSegment', 'The task segment does not match the promotion.');
  }
  if (serving.selection_enabled !== write.enableSelection) {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'enableSelection', 'The selection flag does not match the promotion.');
  }
  if (!sameStages(textInts(serving.stages), write.stages)) {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'stages', 'The stages do not match the promotion.');
  }
  const raced = await client.query<{ raced: boolean }>(
    `SELECT created_at >= transaction_timestamp() AS raced FROM routing_promotions WHERE id = $1`,
    [serving.id],
  );
  if (raced.rows[0]?.raced === true && Number(serving.stage_index) === 1) {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'expectedEpoch', 'A promotion is already active.');
  }
  const stages = textInts(serving.stages);
  const nextIndex = Number(serving.stage_index) + 1;
  const nextBasis = stages[nextIndex - 1];
  if (nextBasis === undefined) {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'stageIndex', 'The promotion is already at the last stage.');
  }
  const updated = await client.query<{ id: string }>(
    `UPDATE routing_promotions
     SET basis_points = $3, stage_index = $4, activation_epoch = activation_epoch + 1, updated_at = statement_timestamp()
     WHERE id = $1 AND activation_epoch = $2 AND status = 'serving'
     RETURNING id::text AS id`,
    [serving.id, write.expectedEpoch, nextBasis, nextIndex],
  );
  const id = updated.rows[0]?.id;
  if (id === undefined) {
    throw proxyError(409, 'invalid_request_error', 'stale_activation', 'expectedEpoch', 'The activation epoch is stale.');
  }
  await insertPromotionEvent(client, {
    tenantId,
    promotionId: id,
    proposalId: null,
    rolloutId,
    action: 'advance',
    actor,
    epoch: write.expectedEpoch + 1,
    basisPoints: nextBasis,
    policyVersionId: serving.policy_version_id,
    previousPolicyVersionId: serving.previous_policy_version_id,
    rollbackDeploymentId: serving.rollback_deployment_id,
    idempotencyKey,
    requestHash,
  });
  return { promotion: await readPromotion(client, id), created: false };
}

export async function saveAutomaticPolicy(
  client: PoolClient,
  tenantId: string,
  write: AutomaticPolicyWrite,
): Promise<AutomaticPolicyView> {
  const saved = await client.query<{
    enabled: boolean;
    approved_candidate_ids: string[];
    quality_min_pass_rate: string;
    min_valid_pairs: number;
    noninferiority_margin: string;
    max_basis_points: number;
    require_guardrails: boolean;
    rollback_verified: boolean;
  }>(
    `INSERT INTO routing_auto_promotion_policies (
       tenant_id, enabled, approved_candidate_ids, quality_min_pass_rate, min_valid_pairs,
       noninferiority_margin, max_basis_points, require_guardrails, rollback_verified
     ) VALUES ($1, $2, $3::uuid[], $4::numeric, $5, $6::numeric, $7, $8, $9)
     ON CONFLICT (tenant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       approved_candidate_ids = EXCLUDED.approved_candidate_ids,
       quality_min_pass_rate = EXCLUDED.quality_min_pass_rate,
       min_valid_pairs = EXCLUDED.min_valid_pairs,
       noninferiority_margin = EXCLUDED.noninferiority_margin,
       max_basis_points = EXCLUDED.max_basis_points,
       require_guardrails = EXCLUDED.require_guardrails,
       rollback_verified = EXCLUDED.rollback_verified,
       updated_at = statement_timestamp()
     RETURNING enabled, approved_candidate_ids::text[] AS approved_candidate_ids,
               quality_min_pass_rate::text AS quality_min_pass_rate, min_valid_pairs,
               noninferiority_margin::text AS noninferiority_margin, max_basis_points,
               require_guardrails, rollback_verified`,
    [
      tenantId,
      write.enabled,
      write.approvedCandidateIds,
      write.qualityMinPassRate,
      write.minValidPairs,
      write.noninferiorityMargin,
      write.maxBasisPoints,
      write.requireGuardrails,
      write.rollbackVerified,
    ],
  );
  const row = saved.rows[0];
  if (row === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return presentAutomatic(row);
}

export async function rejectProposal(
  client: PoolClient,
  tenantId: string,
  rolloutId: string,
  idempotencyKey: string,
  proposalId: string,
): Promise<ProposalView> {
  const requestHash = sha256(JSON.stringify({ rolloutId, kind: 'reject', proposalId }));
  const replay = await readEvent(client, idempotencyKey);
  if (replay !== null) {
    if (replay.request_hash !== requestHash || replay.rollout_id !== rolloutId || replay.action !== 'reject' || replay.proposal_id !== proposalId) {
      throw proxyError(409, 'invalid_request_error', 'idempotency_conflict', 'Idempotency-Key', 'The idempotency key was reused.');
    }
    const stored = await readProposal(client, proposalId);
    if (stored === null) throw proxyError(404, 'invalid_request_error', 'not_found', 'proposalId', 'The proposal was not found.');
    return stored;
  }
  const current = await client.query<{
    id: string;
    status: 'open' | 'rejected' | 'accepted';
    promotion_id: string;
    rollout_id: string;
    policy_version_id: string;
    previous_policy_version_id: string | null;
    rollback_deployment_id: string;
    activation_epoch: number;
  }>(
    `SELECT proposal.id::text AS id, proposal.status, proposal.promotion_id::text AS promotion_id,
            promotion.rollout_id::text AS rollout_id, promotion.policy_version_id::text AS policy_version_id,
            promotion.previous_policy_version_id::text AS previous_policy_version_id,
            promotion.rollback_deployment_id::text AS rollback_deployment_id, promotion.activation_epoch
     FROM routing_policy_proposals proposal
     JOIN routing_promotions promotion ON promotion.tenant_id = proposal.tenant_id AND promotion.id = proposal.promotion_id
     WHERE proposal.id = $1`,
    [proposalId],
  );
  const row = current.rows[0];
  if (row === undefined || row.rollout_id !== rolloutId) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'proposalId', 'The proposal was not found.');
  }
  if (row.status !== 'open') {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'status', 'The proposal is not open.');
  }
  const updated = await client.query(
    `UPDATE routing_policy_proposals
     SET status = 'rejected', updated_at = statement_timestamp()
     WHERE id = $1 AND status = 'open'`,
    [proposalId],
  );
  if ((updated.rowCount ?? 0) !== 1) {
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'status', 'The proposal is not open.');
  }
  await insertPromotionEvent(client, {
    tenantId,
    promotionId: row.promotion_id,
    proposalId,
    rolloutId,
    action: 'reject',
    actor: 'operator',
    epoch: Number(row.activation_epoch),
    basisPoints: 0,
    policyVersionId: row.policy_version_id,
    previousPolicyVersionId: row.previous_policy_version_id,
    rollbackDeploymentId: row.rollback_deployment_id,
    idempotencyKey,
    requestHash,
  });
  const proposal = await readProposal(client, proposalId);
  if (proposal === null) throw proxyError(404, 'invalid_request_error', 'not_found', 'proposalId', 'The proposal was not found.');
  return proposal;
}

export async function retirePromotion(client: PoolClient, rolloutId: string): Promise<void> {
  const updated = await client.query<{
    id: string;
    tenant_id: string;
    activation_epoch: number;
    basis_points: number;
    policy_version_id: string;
    previous_policy_version_id: string | null;
    rollback_deployment_id: string;
  }>(
    `UPDATE routing_promotions
     SET status = 'rolled_back', activation_epoch = activation_epoch + 1, updated_at = statement_timestamp()
     WHERE rollout_id = $1 AND status = 'serving'
     RETURNING id::text AS id, tenant_id::text AS tenant_id, activation_epoch, basis_points,
               policy_version_id::text AS policy_version_id,
               previous_policy_version_id::text AS previous_policy_version_id,
               rollback_deployment_id::text AS rollback_deployment_id`,
    [rolloutId],
  );
  const row = updated.rows[0];
  if (row === undefined) return;
  const oldEpoch = Number(row.activation_epoch) - 1;
  const idempotencyKey = `retire:${rolloutId}:${oldEpoch}`;
  const requestHash = sha256(idempotencyKey);
  try {
    await insertPromotionEvent(client, {
      tenantId: row.tenant_id,
      promotionId: row.id,
      proposalId: null,
      rolloutId,
      action: 'rollback',
      actor: 'operator',
      epoch: Number(row.activation_epoch),
      basisPoints: Number(row.basis_points),
      policyVersionId: row.policy_version_id,
      previousPolicyVersionId: row.previous_policy_version_id,
      rollbackDeploymentId: row.rollback_deployment_id,
      idempotencyKey,
      requestHash,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

export async function proposeFromSnapshot(client: PoolClient, tenantId: string, snapshotId: string): Promise<ProposalView | null> {
  const serving = await client.query<{ id: string; policy_version_id: string; rollout_id: string }>(
    `SELECT id::text AS id, policy_version_id::text AS policy_version_id, rollout_id::text AS rollout_id
     FROM routing_promotions
     WHERE alias = 'auto' AND status = 'serving'
     LIMIT 1`,
  );
  const promotion = serving.rows[0];
  if (promotion === undefined) return null;
  const loaded = await client.query<{
    task_category: string;
    candidate_deployment_id: string;
    candidate_name: string;
    model_version: string;
    profile_config_version: number;
    upstream_model: string;
    config_version: number;
    wilson_lower: string | null;
    candidate_ids: string[];
    task_segments: string[];
    prior_wilson: string | null;
    source_run_ids: string[] | null;
    prior_run_ids: string[] | null;
    evidence_status: string;
    reason_codes: string[];
    matched_pairs: number;
    difference_lower: string | null;
    evidence_fresh: boolean;
    min_samples: number;
    noninferiority_margin: string;
    quality_min_pass_rate: string;
    quality_min_valid_pairs: number;
  }>(
    `SELECT profile.task_category, profile.candidate_deployment_id::text AS candidate_deployment_id,
            deployment.name AS candidate_name, profile.model_version,
            profile.deployment_config_version AS profile_config_version,
            deployment.upstream_model, deployment.config_version,
            assessment.wilson_lower::text AS wilson_lower,
            version.candidate_deployment_ids::text[] AS candidate_ids, version.task_segments,
            prior.wilson_lower::text AS prior_wilson,
            snapshot.source_run_ids::text[] AS source_run_ids,
            prior.source_run_ids::text[] AS prior_run_ids,
            assessment.status AS evidence_status, assessment.reason_codes, snapshot.matched_pairs,
            assessment.difference_lower::text AS difference_lower,
            (snapshot.created_at + make_interval(secs => profile.freshness_seconds) > statement_timestamp()) AS evidence_fresh,
            profile.min_samples, profile.noninferiority_margin::text AS noninferiority_margin,
            version.quality_min_pass_rate::text AS quality_min_pass_rate, version.quality_min_valid_pairs
     FROM evidence_snapshots snapshot
     JOIN qualification_profile_versions profile
       ON profile.tenant_id = snapshot.tenant_id AND profile.id = snapshot.profile_version_id
     JOIN evidence_candidate_assessments assessment
       ON assessment.tenant_id = snapshot.tenant_id AND assessment.snapshot_id = snapshot.id
     JOIN model_deployments deployment
       ON deployment.tenant_id = profile.tenant_id AND deployment.id = profile.candidate_deployment_id
     JOIN routing_policy_versions version
       ON version.tenant_id = snapshot.tenant_id AND version.id = $2
     LEFT JOIN LATERAL (
       SELECT old_assessment.wilson_lower, old_snapshot.source_run_ids
       FROM evidence_snapshots old_snapshot
       JOIN qualification_profile_versions old_profile
         ON old_profile.tenant_id = old_snapshot.tenant_id AND old_profile.id = old_snapshot.profile_version_id
       JOIN evidence_candidate_assessments old_assessment
         ON old_assessment.tenant_id = old_snapshot.tenant_id AND old_assessment.snapshot_id = old_snapshot.id
       WHERE old_profile.candidate_deployment_id = profile.candidate_deployment_id
         AND old_profile.task_category = profile.task_category
         AND old_snapshot.id <> snapshot.id
       ORDER BY old_snapshot.created_at DESC
       LIMIT 1
     ) prior ON true
     WHERE snapshot.id = $1`,
    [snapshotId, promotion.policy_version_id],
  );
  const row = loaded.rows[0];
  if (row === undefined || !textList(row.task_segments).includes(row.task_category)) return null;
  const candidates = textList(row.candidate_ids);
  const currentMedian = await evidenceMedians(client, textList(row.source_run_ids), row.candidate_name);
  const priorMedian = await evidenceMedians(client, textList(row.prior_run_ids), row.candidate_name);
  let changeKind: ProposalView['changeKind'] | null = null;
  if (!candidates.includes(row.candidate_deployment_id)) changeKind = 'candidate';
  else if (row.model_version !== row.upstream_model || Number(row.profile_config_version) !== Number(row.config_version)) changeKind = 'version';
  else if (decimalChanged(row.prior_wilson, row.wilson_lower)) changeKind = 'quality';
  else if (medianChanged(currentMedian.cost, priorMedian.cost)) changeKind = 'cost';
  else if (medianChanged(currentMedian.latency, priorMedian.latency)) changeKind = 'latency';
  if (changeKind === null) return null;
  const ops = await loadProposalOperations(client, promotion.rollout_id, row.candidate_deployment_id);
  if (ops === null) return null;
  const samples = Number(ops.canary_samples);
  const gate = evaluatePromotionGates({
    evidenceStatus: row.evidence_status,
    reasonCodes: textList(row.reason_codes),
    evidenceFresh: row.evidence_fresh === true,
    modelVersionMatches: row.model_version === row.upstream_model,
    configVersionMatches: Number(row.profile_config_version) === Number(row.config_version),
    matchedPairs: Number(row.matched_pairs),
    minMatchedPairs: Number(row.quality_min_valid_pairs),
    wilsonLower: row.wilson_lower === null ? null : Number(row.wilson_lower),
    qualityMinPassRate: Number(row.quality_min_pass_rate),
    noninferiorityRequired: Number(row.noninferiority_margin) > 0,
    differenceLower: row.difference_lower === null ? null : Number(row.difference_lower),
    noninferiorityMargin: Number(row.noninferiority_margin),
    canarySamples: samples,
    minCanarySamples: Number(row.min_samples),
    reliability: samples === 0 ? null : 1 - Number(ops.canary_failed) / samples,
    reliabilityTarget: RELIABILITY_TARGET,
    latencyP95Ms: ops.latency_p95 === null ? null : Number(ops.latency_p95),
    maxLatencyMs: Number(ops.max_latency_ms),
    canaryCost: ops.canary_cost === null ? null : Number(ops.canary_cost),
    baselineCost: ops.baseline_cost === null ? null : Number(ops.baseline_cost),
    maxCostPerRequest: Number(ops.max_cost_per_request),
    budgetValid: budgetAllows(ops.budget_mode, ops.monthly_amount),
    providerValid: providerAllows(ops),
    unresolvedCritical: Number(ops.critical_error_count) > 0 || Number(ops.violation_count) > 0,
  });
  try {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO routing_policy_proposals (
         tenant_id, promotion_id, evidence_snapshot_id, task_segment, candidate_deployment_id,
         change_kind, gate_name, status
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
       RETURNING id::text AS id`,
      [
        tenantId,
        promotion.id,
        snapshotId,
        row.task_category,
        row.candidate_deployment_id,
        changeKind,
        gate.pass ? 'pass' : gate.gate,
      ],
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) return null;
    return readProposal(client, id);
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return null;
  }
}

export async function runAutomaticPromotion(
  client: PoolClient,
  tenantId: string,
): Promise<{ promoted: boolean; reason: string }> {
  const policy = await client.query<{
    enabled: boolean;
    approved_candidate_ids: string[];
    quality_min_pass_rate: string;
    min_valid_pairs: number;
    noninferiority_margin: string;
    max_basis_points: number;
    require_guardrails: boolean;
    rollback_verified: boolean;
  }>(
    `SELECT enabled, approved_candidate_ids::text[] AS approved_candidate_ids,
            quality_min_pass_rate::text AS quality_min_pass_rate, min_valid_pairs,
            noninferiority_margin::text AS noninferiority_margin, max_basis_points,
            require_guardrails, rollback_verified
     FROM routing_auto_promotion_policies`,
  );
  const automatic = policy.rows[0];
  if (automatic === undefined || automatic.enabled !== true) return { promoted: false, reason: 'disabled' };
  const rollout = await client.query<{
    id: string;
    epoch: number;
    challenger_deployment_id: string;
    task_category: string;
    baseline_ready: boolean;
  }>(
    `SELECT rollout.id::text AS id, rollout.epoch, rollout.challenger_deployment_id::text AS challenger_deployment_id,
            profile.task_category,
            (baseline.enabled AND connection.enabled AND baseline.validation_status = 'validated_live') AS baseline_ready
     FROM routing_rollouts rollout
     JOIN evidence_snapshots snapshot ON snapshot.tenant_id = rollout.tenant_id AND snapshot.id = rollout.evidence_snapshot_id
     JOIN qualification_profile_versions profile
       ON profile.tenant_id = snapshot.tenant_id AND profile.id = snapshot.profile_version_id
     JOIN model_deployments baseline ON baseline.tenant_id = rollout.tenant_id AND baseline.id = rollout.baseline_deployment_id
     JOIN provider_connections connection ON connection.tenant_id = baseline.tenant_id AND connection.id = baseline.connection_id
     WHERE rollout.alias = 'auto' AND rollout.status = 'active'
     LIMIT 1`,
  );
  const active = rollout.rows[0];
  if (active === undefined) return { promoted: false, reason: 'no_rollout' };
  if (!textList(automatic.approved_candidate_ids).includes(active.challenger_deployment_id)) {
    return { promoted: false, reason: 'candidate_not_approved' };
  }
  if (automatic.rollback_verified !== true || active.baseline_ready !== true) {
    return { promoted: false, reason: 'rollback_unverified' };
  }
  if (automatic.require_guardrails) {
    const guard = await client.query(`SELECT 1 FROM routing_guardrail_sets WHERE rollout_id = $1 LIMIT 1`, [active.id]);
    if ((guard.rowCount ?? 0) === 0) return { promoted: false, reason: 'guardrails_required' };
  }
  const serving = await client.query<{
    activation_epoch: number;
    stages: number[];
    stage_index: number;
    task_segment: string;
    selection_enabled: boolean;
  }>(
    `SELECT activation_epoch, stages, stage_index, task_segment, selection_enabled
     FROM routing_promotions
     WHERE rollout_id = $1 AND status = 'serving'`,
    [active.id],
  );
  const current = serving.rows[0];
  const stages = current === undefined ? [...DEFAULT_STAGES] : textInts(current.stages);
  const nextBasis = current === undefined ? stages[0] : stages[Number(current.stage_index)];
  if (nextBasis === undefined || nextBasis > Number(automatic.max_basis_points)) {
    return { promoted: false, reason: 'progression_limit' };
  }
  const expectedEpoch = current === undefined ? Number(active.epoch) : Number(current.activation_epoch);
  const taskSegment = current === undefined ? active.task_category : current.task_segment;
  if (!isTaskCategory(taskSegment)) return { promoted: false, reason: 'segment_mismatch' };
  await client.query('SAVEPOINT auto_promote');
  try {
    const saved = await promoteRollout(
      client,
      tenantId,
      active.id,
      `auto:${active.id}:${expectedEpoch}`,
      {
        expectedEpoch,
        taskSegment,
        stages,
        enableSelection: current?.selection_enabled === true,
      },
      'automatic',
      {
        qualityMinPassRate: Number(automatic.quality_min_pass_rate),
        minValidPairs: Number(automatic.min_valid_pairs),
        noninferiorityMargin: Number(automatic.noninferiority_margin),
      },
    );
    await client.query('RELEASE SAVEPOINT auto_promote');
    return { promoted: saved.created, reason: saved.created ? 'promoted' : 'replayed' };
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT auto_promote');
    await client.query('RELEASE SAVEPOINT auto_promote');
    if (error instanceof ProxyError && error.code === 'promotion_rejected') {
      return { promoted: false, reason: error.param ?? 'promotion_rejected' };
    }
    if (error instanceof ProxyError) return { promoted: false, reason: error.code ?? 'rejected' };
    throw error;
  }
}

export async function readPromotionAttachment(client: PoolClient, policyId: string): Promise<PolicyPromotionAttachment> {
  const serving = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM routing_promotions WHERE policy_id = $1 AND status = 'serving' LIMIT 1`,
    [policyId],
  );
  const promotionId = serving.rows[0]?.id;
  const proposals = await client.query<{
    id: string;
    evidence_snapshot_id: string;
    task_segment: string;
    candidate_deployment: string;
    change_kind: ProposalView['changeKind'];
    gate_name: string;
    status: ProposalView['status'];
  }>(
    `SELECT proposal.id::text AS id, proposal.evidence_snapshot_id::text AS evidence_snapshot_id,
            proposal.task_segment, deployment.name AS candidate_deployment, proposal.change_kind,
            proposal.gate_name, proposal.status
     FROM routing_policy_proposals proposal
     JOIN routing_promotions promotion ON promotion.tenant_id = proposal.tenant_id AND promotion.id = proposal.promotion_id
     JOIN model_deployments deployment ON deployment.tenant_id = proposal.tenant_id AND deployment.id = proposal.candidate_deployment_id
     WHERE promotion.policy_id = $1
     ORDER BY proposal.created_at, proposal.id`,
    [policyId],
  );
  const automatic = await client.query<{
    enabled: boolean;
    approved_candidate_ids: string[];
    quality_min_pass_rate: string;
    min_valid_pairs: number;
    noninferiority_margin: string;
    max_basis_points: number;
    require_guardrails: boolean;
    rollback_verified: boolean;
  }>(
    `SELECT enabled, approved_candidate_ids::text[] AS approved_candidate_ids,
            quality_min_pass_rate::text AS quality_min_pass_rate, min_valid_pairs,
            noninferiority_margin::text AS noninferiority_margin, max_basis_points,
            require_guardrails, rollback_verified
     FROM routing_auto_promotion_policies`,
  );
  return {
    promotion: promotionId === undefined ? null : await readPromotion(client, promotionId),
    proposals: proposals.rows.map((row) => ({
      id: row.id,
      evidenceSnapshotId: row.evidence_snapshot_id,
      taskSegment: row.task_segment,
      candidateDeployment: row.candidate_deployment,
      changeKind: row.change_kind,
      gateName: row.gate_name,
      status: row.status,
      requiresShadow: true,
      requiresCanary: true,
    })),
    automaticPromotion: automatic.rows[0] === undefined ? null : presentAutomatic(automatic.rows[0]),
  };
}

export async function readDecisionSelection(client: PoolClient, requestId: string): Promise<DecisionSelectionView> {
  const result = await client.query<{
    promotion_id: string;
    policy_version_id: string;
    activation_epoch: number;
    promotion_status: 'serving' | 'rolled_back';
    reason: string;
    task_segment: string;
    baseline_deployment: string;
    selected_deployment: string;
    expected_cost: string | null;
  }>(
    `SELECT selection.promotion_id::text AS promotion_id, selection.policy_version_id::text AS policy_version_id,
            selection.activation_epoch, promotion.status AS promotion_status, selection.reason, selection.task_segment,
            baseline.name AS baseline_deployment, selected.name AS selected_deployment,
            selection.expected_cost::text AS expected_cost
     FROM routing_selection_decisions selection
     JOIN routing_promotions promotion ON promotion.tenant_id = selection.tenant_id AND promotion.id = selection.promotion_id
     JOIN model_deployments baseline ON baseline.tenant_id = selection.tenant_id AND baseline.id = selection.baseline_deployment_id
     JOIN model_deployments selected ON selected.tenant_id = selection.tenant_id AND selected.id = selection.selected_deployment_id
     WHERE selection.request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  if (row === undefined) return { promotion: null, selection: null };
  return {
    promotion: {
      id: row.promotion_id,
      policyVersionId: row.policy_version_id,
      activationEpoch: Number(row.activation_epoch),
      status: row.promotion_status,
    },
    selection: {
      reason: row.reason,
      taskSegment: row.task_segment,
      baselineDeployment: row.baseline_deployment,
      selectedDeployment: row.selected_deployment,
      expectedCost: row.expected_cost === null ? null : fixedDecimal(row.expected_cost, 8),
    },
  };
}

async function insertPromotion(
  client: PoolClient,
  tenantId: string,
  rollout: RolloutGateRow,
  write: PromoteWrite,
  actor: PromotionActor,
  requestHash: string,
  idempotencyKey: string,
): Promise<PromotionView> {
  const first = write.stages[0];
  if (first === undefined) throw invalidRequest('stages', 'invalid_parameter', 'The stages are invalid.');
  const previous = await client.query<{ id: string; policy_version_id: string }>(
    `SELECT id::text AS id, policy_version_id::text AS policy_version_id
     FROM routing_promotions
     WHERE alias = 'auto' AND status = 'rolled_back'
     ORDER BY updated_at DESC
     LIMIT 1`,
  );
  const prior = previous.rows[0];
  await client.query('SAVEPOINT promotion_create');
  try {
    const inserted = await client.query<{ id: string; activation_epoch: number }>(
      `INSERT INTO routing_promotions (
         tenant_id, rollout_id, policy_id, policy_version_id, previous_policy_version_id, previous_promotion_id,
         rollback_deployment_id, alias, activation_epoch, basis_points, stages, stage_index, task_segment,
         selection_enabled, status, actor
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, 'auto',
         (SELECT GREATEST(COALESCE(MAX(activation_epoch), 0) + 1, $13::integer) FROM routing_promotions),
         $8, $9::integer[], 1, $10, $11, 'serving', $12
       )
       RETURNING id::text AS id, activation_epoch`,
      [
        tenantId,
        rollout.id,
        rollout.policy_id,
        rollout.version_id,
        prior?.policy_version_id ?? null,
        prior?.id ?? null,
        rollout.baseline_deployment_id,
        first,
        write.stages,
        write.taskSegment,
        write.enableSelection,
        actor,
        write.expectedEpoch + 1,
      ],
    );
    const created = inserted.rows[0];
    if (created === undefined) throw new Error('promotion was not stored');
    await insertPromotionEvent(client, {
      tenantId,
      promotionId: created.id,
      proposalId: null,
      rolloutId: rollout.id,
      action: 'promote',
      actor,
      epoch: Number(created.activation_epoch),
      basisPoints: first,
      policyVersionId: rollout.version_id,
      previousPolicyVersionId: prior?.policy_version_id ?? null,
      rollbackDeploymentId: rollout.baseline_deployment_id,
      idempotencyKey,
      requestHash,
    });
    await client.query('RELEASE SAVEPOINT promotion_create');
    return readPromotion(client, created.id);
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT promotion_create');
    await client.query('RELEASE SAVEPOINT promotion_create');
    if (!isUniqueViolation(error)) throw error;
    const raced = await readEvent(client, idempotencyKey);
    if (raced?.request_hash === requestHash && raced.promotion_id !== null) {
      return readPromotion(client, raced.promotion_id);
    }
    throw proxyError(409, 'invalid_request_error', 'activation_conflict', 'expectedEpoch', 'A promotion is already active.');
  }
}

async function lockRollout(client: PoolClient, rolloutId: string): Promise<RolloutGateRow> {
  const result = await client.query<RolloutGateRow>(
    `SELECT rollout.id::text AS id, rollout.policy_id::text AS policy_id, rollout.version_id::text AS version_id,
            rollout.epoch, rollout.status, rollout.evidence_snapshot_id::text AS evidence_snapshot_id,
            rollout.baseline_deployment_id::text AS baseline_deployment_id,
            rollout.challenger_deployment_id::text AS challenger_deployment_id,
            rollout.critical_error_count,
            version.quality_min_pass_rate::text AS quality_min_pass_rate, version.quality_min_valid_pairs,
            version.max_cost_per_request::text AS max_cost_per_request, version.max_latency_ms,
            version.task_segments, version.candidate_deployment_ids::text[] AS candidate_deployment_ids,
            activation.status AS activation_status,
            assessment.status AS evidence_status, assessment.reason_codes, snapshot.matched_pairs,
            assessment.wilson_lower::text AS wilson_lower, assessment.difference_lower::text AS difference_lower,
            (snapshot.created_at + make_interval(secs => profile.freshness_seconds) > statement_timestamp()) AS evidence_fresh,
            profile.task_category AS profile_task, profile.candidate_deployment_id::text AS profile_candidate_id,
            profile.model_version, profile.deployment_config_version AS profile_config_version, profile.min_samples,
            profile.noninferiority_margin::text AS noninferiority_margin,
            challenger.upstream_model, challenger.config_version, challenger.enabled AS challenger_enabled,
            connection.enabled AS challenger_connection_enabled, challenger.validation_status AS challenger_validated,
            connection.provider AS challenger_provider, connection.location AS challenger_location,
            challenger.data_collection AS challenger_data_collection,
            fallback.enabled AS fallback_enabled, fallback.allowed_providers, fallback.allowed_regions,
            fallback.data_collection AS fallback_data_collection,
            budget.mode AS budget_mode, budget.monthly_amount::text AS monthly_amount,
            cohort.samples AS canary_samples, cohort.failed AS canary_failed, cohort.latency_p95::text AS latency_p95,
            canary_cost.median::text AS canary_cost, baseline_cost.median::text AS baseline_cost,
            (SELECT count(*)::int FROM routing_guardrail_violations violation WHERE violation.rollout_id = rollout.id) AS violation_count
     FROM routing_rollouts rollout
     JOIN routing_policy_versions version ON version.tenant_id = rollout.tenant_id AND version.id = rollout.version_id
     JOIN routing_policy_activations activation ON activation.tenant_id = rollout.tenant_id AND activation.policy_id = rollout.policy_id
     JOIN evidence_snapshots snapshot ON snapshot.tenant_id = rollout.tenant_id AND snapshot.id = rollout.evidence_snapshot_id
     JOIN evidence_candidate_assessments assessment
       ON assessment.tenant_id = snapshot.tenant_id AND assessment.snapshot_id = snapshot.id
     JOIN qualification_profile_versions profile
       ON profile.tenant_id = snapshot.tenant_id AND profile.id = snapshot.profile_version_id
     JOIN model_deployments challenger ON challenger.tenant_id = rollout.tenant_id AND challenger.id = rollout.challenger_deployment_id
     JOIN provider_connections connection ON connection.tenant_id = challenger.tenant_id AND connection.id = challenger.connection_id
     LEFT JOIN model_aliases alias ON alias.tenant_id = rollout.tenant_id AND alias.alias = 'auto'
     LEFT JOIN fallback_policies fallback ON fallback.tenant_id = alias.tenant_id AND fallback.id = alias.fallback_policy_id
     LEFT JOIN tenant_budgets budget ON budget.tenant_id = rollout.tenant_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS samples,
              count(*) FILTER (WHERE attempt.failure_class IS NOT NULL)::int AS failed,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY attempt.duration_ms) AS latency_p95
       FROM routing_canary_assignments assignment
       LEFT JOIN model_attempts attempt
         ON attempt.tenant_id = assignment.tenant_id
        AND attempt.request_id = assignment.request_id
        AND attempt.deployment_id = assignment.cohort_deployment_id
       WHERE assignment.rollout_id = rollout.id AND assignment.cohort = 'canary'
     ) cohort ON true
     LEFT JOIN LATERAL (
       SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY cost.amount) AS median
       FROM routing_canary_assignments assignment
       JOIN model_attempts attempt
         ON attempt.tenant_id = assignment.tenant_id
        AND attempt.request_id = assignment.request_id
        AND attempt.deployment_id = assignment.cohort_deployment_id
       JOIN attempt_costs cost
         ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
        AND cost.cost_status IN ('estimated', 'provisional', 'reconciled')
       WHERE assignment.rollout_id = rollout.id AND assignment.cohort = 'canary'
     ) canary_cost ON true
     LEFT JOIN LATERAL (
       SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY cost.amount) AS median
       FROM routing_canary_assignments assignment
       JOIN model_attempts attempt
         ON attempt.tenant_id = assignment.tenant_id
        AND attempt.request_id = assignment.request_id
        AND attempt.deployment_id = assignment.cohort_deployment_id
       JOIN attempt_costs cost
         ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
        AND cost.cost_status IN ('estimated', 'provisional', 'reconciled')
       WHERE assignment.rollout_id = rollout.id AND assignment.cohort = 'baseline'
     ) baseline_cost ON true
     WHERE rollout.id = $1
     FOR UPDATE OF rollout`,
    [rolloutId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw proxyError(404, 'invalid_request_error', 'not_found', 'rollout_id', 'The rollout was not found.');
  }
  if (row.status !== 'active') {
    throw proxyError(409, 'invalid_request_error', 'promotion_during_rollback', 'rollout_id', 'A promotion cannot run during rollback.');
  }
  return row;
}

function factsFrom(row: RolloutGateRow, floor: PromotionFloor | null): PromotionFacts {
  const samples = Number(row.canary_samples);
  const providerValid = providerAllows(row);
  const budgetValid = budgetAllows(row.budget_mode, row.monthly_amount);
  return {
    evidenceStatus: row.evidence_status,
    reasonCodes: textList(row.reason_codes),
    evidenceFresh: row.evidence_fresh === true,
    modelVersionMatches: row.profile_candidate_id === row.challenger_deployment_id && row.model_version === row.upstream_model,
    configVersionMatches: Number(row.profile_config_version) === Number(row.config_version),
    matchedPairs: Number(row.matched_pairs),
    minMatchedPairs: Math.max(Number(row.quality_min_valid_pairs), floor?.minValidPairs ?? 0),
    wilsonLower: row.wilson_lower === null ? null : Number(row.wilson_lower),
    qualityMinPassRate: Math.max(Number(row.quality_min_pass_rate), floor?.qualityMinPassRate ?? 0),
    ...tighterMargin(Number(row.noninferiority_margin), floor?.noninferiorityMargin),
    differenceLower: row.difference_lower === null ? null : Number(row.difference_lower),
    canarySamples: samples,
    minCanarySamples: Number(row.min_samples),
    reliability: samples === 0 ? null : 1 - Number(row.canary_failed) / samples,
    reliabilityTarget: RELIABILITY_TARGET,
    latencyP95Ms: row.latency_p95 === null ? null : Number(row.latency_p95),
    maxLatencyMs: Number(row.max_latency_ms),
    canaryCost: row.canary_cost === null ? null : Number(row.canary_cost),
    baselineCost: row.baseline_cost === null ? null : Number(row.baseline_cost),
    maxCostPerRequest: Number(row.max_cost_per_request),
    budgetValid,
    providerValid,
    unresolvedCritical: Number(row.critical_error_count) > 0 || Number(row.violation_count) > 0,
  };
}

type ProviderGateRow = {
  challenger_enabled: boolean;
  challenger_connection_enabled: boolean;
  challenger_validated: string;
  challenger_provider: string;
  challenger_location: string | null;
  challenger_data_collection: 'allow' | 'deny' | null;
  fallback_enabled: boolean | null;
  allowed_providers: string[] | null;
  allowed_regions: string[] | null;
  fallback_data_collection: 'allow' | 'deny' | null;
};

type ProposalOperations = ProviderGateRow & {
  canary_samples: number;
  canary_failed: number;
  latency_p95: string | null;
  canary_cost: string | null;
  baseline_cost: string | null;
  critical_error_count: number;
  violation_count: number;
  max_cost_per_request: string;
  max_latency_ms: number;
  budget_mode: string | null;
  monthly_amount: string | null;
};

function tighterMargin(profileMargin: number, floorMargin: number | undefined): {
  noninferiorityRequired: boolean;
  noninferiorityMargin: number;
} {
  const positive = [profileMargin, floorMargin].filter((value): value is number => value !== undefined && value > 0);
  if (positive.length === 0) return { noninferiorityRequired: false, noninferiorityMargin: 0 };
  return { noninferiorityRequired: true, noninferiorityMargin: Math.min(...positive) };
}

function decimalChanged(left: string | null, right: string | null): boolean {
  if (left === null && right === null) return false;
  if (left === null || right === null) return true;
  return Number(left) !== Number(right);
}

function medianChanged(left: number | null, right: number | null): boolean {
  if (left === null && right === null) return false;
  if (left === null || right === null) return true;
  return left !== right;
}

async function evidenceMedians(
  client: PoolClient,
  runIds: readonly string[],
  deploymentName: string,
): Promise<{ cost: number | null; latency: number | null }> {
  if (runIds.length === 0) return { cost: null, latency: null };
  const attempts = await client.query<{
    cost_amount: string | null;
    cost_status: string | null;
    latency_ms: number | null;
  }>(
    `SELECT cost_amount::text AS cost_amount, cost_status, latency_ms
     FROM evaluation_attempts
     WHERE run_id = ANY($1::uuid[])
       AND status = 'completed'
       AND challenger_deployment = $2`,
    [runIds, deploymentName],
  );
  if (attempts.rows.length === 0) return { cost: null, latency: null };
  const costs: number[] = [];
  const latencies: number[] = [];
  let costKnown = true;
  let latencyKnown = true;
  for (const attempt of attempts.rows) {
    const cost = knownAttemptCost(attempt.cost_amount, attempt.cost_status);
    if (cost === null) costKnown = false;
    else costs.push(cost);
    if (attempt.latency_ms === null) latencyKnown = false;
    else latencies.push(Number(attempt.latency_ms));
  }
  return {
    cost: costKnown ? medianStored(costs) : null,
    latency: latencyKnown ? medianStored(latencies) : null,
  };
}

async function loadProposalOperations(
  client: PoolClient,
  rolloutId: string,
  candidateDeploymentId: string,
): Promise<ProposalOperations | null> {
  const result = await client.query<ProposalOperations>(
    `SELECT rollout.critical_error_count,
            version.max_cost_per_request::text AS max_cost_per_request, version.max_latency_ms,
            deployment.enabled AS challenger_enabled,
            connection.enabled AS challenger_connection_enabled,
            deployment.validation_status AS challenger_validated,
            connection.provider AS challenger_provider, connection.location AS challenger_location,
            deployment.data_collection AS challenger_data_collection,
            fallback.enabled AS fallback_enabled, fallback.allowed_providers, fallback.allowed_regions,
            fallback.data_collection AS fallback_data_collection,
            budget.mode AS budget_mode, budget.monthly_amount::text AS monthly_amount,
            cohort.samples AS canary_samples, cohort.failed AS canary_failed, cohort.latency_p95::text AS latency_p95,
            canary_cost.median::text AS canary_cost, baseline_cost.median::text AS baseline_cost,
            (SELECT count(*)::int FROM routing_guardrail_violations violation WHERE violation.rollout_id = rollout.id) AS violation_count
     FROM routing_rollouts rollout
     JOIN routing_policy_versions version ON version.tenant_id = rollout.tenant_id AND version.id = rollout.version_id
     JOIN model_deployments deployment ON deployment.tenant_id = rollout.tenant_id AND deployment.id = $2
     JOIN provider_connections connection ON connection.tenant_id = deployment.tenant_id AND connection.id = deployment.connection_id
     LEFT JOIN model_aliases alias ON alias.tenant_id = rollout.tenant_id AND alias.alias = 'auto'
     LEFT JOIN fallback_policies fallback ON fallback.tenant_id = alias.tenant_id AND fallback.id = alias.fallback_policy_id
     LEFT JOIN tenant_budgets budget ON budget.tenant_id = rollout.tenant_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS samples,
              count(*) FILTER (WHERE attempt.failure_class IS NOT NULL)::int AS failed,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY attempt.duration_ms) AS latency_p95
       FROM routing_canary_assignments assignment
       LEFT JOIN model_attempts attempt
         ON attempt.tenant_id = assignment.tenant_id
        AND attempt.request_id = assignment.request_id
        AND attempt.deployment_id = assignment.cohort_deployment_id
       WHERE assignment.rollout_id = rollout.id
         AND assignment.cohort = 'canary'
         AND assignment.cohort_deployment_id = deployment.id
     ) cohort ON true
     LEFT JOIN LATERAL (
       SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY cost.amount) AS median
       FROM routing_canary_assignments assignment
       JOIN model_attempts attempt
         ON attempt.tenant_id = assignment.tenant_id
        AND attempt.request_id = assignment.request_id
        AND attempt.deployment_id = assignment.cohort_deployment_id
       JOIN attempt_costs cost
         ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
        AND cost.cost_status IN ('estimated', 'provisional', 'reconciled')
       WHERE assignment.rollout_id = rollout.id
         AND assignment.cohort = 'canary'
         AND assignment.cohort_deployment_id = deployment.id
     ) canary_cost ON true
     LEFT JOIN LATERAL (
       SELECT percentile_disc(0.5) WITHIN GROUP (ORDER BY cost.amount) AS median
       FROM routing_canary_assignments assignment
       JOIN model_attempts attempt
         ON attempt.tenant_id = assignment.tenant_id
        AND attempt.request_id = assignment.request_id
        AND attempt.deployment_id = assignment.cohort_deployment_id
       JOIN attempt_costs cost
         ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
        AND cost.cost_status IN ('estimated', 'provisional', 'reconciled')
       WHERE assignment.rollout_id = rollout.id AND assignment.cohort = 'baseline'
     ) baseline_cost ON true
     WHERE rollout.id = $1`,
    [rolloutId, candidateDeploymentId],
  );
  return result.rows[0] ?? null;
}

function providerAllows(row: ProviderGateRow): boolean {
  if (!row.challenger_enabled || !row.challenger_connection_enabled || row.challenger_validated !== 'validated_live') return false;
  if (row.fallback_enabled !== true) return true;
  const providers = textList(row.allowed_providers);
  if (!providers.includes(row.challenger_provider)) return false;
  if (row.challenger_data_collection === null || row.challenger_data_collection !== row.fallback_data_collection) return false;
  const regions = textList(row.allowed_regions);
  if (regions.length > 0 && (row.challenger_location === null || !regions.includes(row.challenger_location))) return false;
  return true;
}

function budgetAllows(mode: string | null, monthlyAmount: string | null): boolean {
  if (mode === null || mode === 'disabled' || mode === 'observe') return true;
  if (mode !== 'hard') return false;
  return monthlyAmount !== null && Number(monthlyAmount) > 0;
}

async function lockServing(client: PoolClient, rolloutId: string): Promise<{
  id: string;
  activation_epoch: number;
  stages: number[];
  stage_index: number;
  task_segment: string;
  selection_enabled: boolean;
  policy_version_id: string;
  previous_policy_version_id: string | null;
  rollback_deployment_id: string;
} | null> {
  const result = await client.query<{
    id: string;
    activation_epoch: number;
    stages: number[];
    stage_index: number;
    task_segment: string;
    selection_enabled: boolean;
    policy_version_id: string;
    previous_policy_version_id: string | null;
    rollback_deployment_id: string;
  }>(
    `SELECT id::text AS id, activation_epoch, stages, stage_index, task_segment, selection_enabled,
            policy_version_id::text AS policy_version_id,
            previous_policy_version_id::text AS previous_policy_version_id,
            rollback_deployment_id::text AS rollback_deployment_id
     FROM routing_promotions
     WHERE rollout_id = $1 AND status = 'serving'
     FOR UPDATE`,
    [rolloutId],
  );
  return result.rows[0] ?? null;
}

async function readPromotion(client: PoolClient, promotionId: string): Promise<PromotionView> {
  const result = await client.query<{
    id: string;
    rollout_id: string;
    policy_id: string;
    policy_version_id: string;
    previous_policy_version_id: string | null;
    rollback_deployment: string;
    activation_epoch: number;
    basis_points: number;
    stages: number[];
    stage_index: number;
    task_segment: TaskCategory;
    selection_enabled: boolean;
    status: 'serving' | 'rolled_back';
    actor: PromotionActor;
  }>(
    `SELECT promotion.id::text AS id, promotion.rollout_id::text AS rollout_id, promotion.policy_id::text AS policy_id,
            promotion.policy_version_id::text AS policy_version_id,
            promotion.previous_policy_version_id::text AS previous_policy_version_id,
            deployment.name AS rollback_deployment, promotion.activation_epoch, promotion.basis_points,
            promotion.stages, promotion.stage_index, promotion.task_segment, promotion.selection_enabled,
            promotion.status, promotion.actor
     FROM routing_promotions promotion
     JOIN model_deployments deployment
       ON deployment.tenant_id = promotion.tenant_id AND deployment.id = promotion.rollback_deployment_id
     WHERE promotion.id = $1`,
    [promotionId],
  );
  const row = result.rows[0];
  if (row === undefined) throw proxyError(404, 'invalid_request_error', 'not_found', 'promotion_id', 'The promotion was not found.');
  const events = await client.query<{
    action: PromotionEventView['action'];
    actor: PromotionActor;
    activation_epoch: number;
    basis_points: number;
    policy_version_id: string;
    previous_policy_version_id: string | null;
    rollback_deployment: string;
  }>(
    `SELECT event.action, event.actor, event.activation_epoch, event.basis_points,
            event.policy_version_id::text AS policy_version_id,
            event.previous_policy_version_id::text AS previous_policy_version_id,
            deployment.name AS rollback_deployment
     FROM routing_promotion_events event
     JOIN model_deployments deployment
       ON deployment.tenant_id = event.tenant_id AND deployment.id = event.rollback_deployment_id
     WHERE event.promotion_id = $1
     ORDER BY event.created_at, event.activation_epoch`,
    [promotionId],
  );
  return {
    id: row.id,
    rolloutId: row.rollout_id,
    policyId: row.policy_id,
    policyVersionId: row.policy_version_id,
    previousPolicyVersionId: row.previous_policy_version_id,
    rollbackDeployment: row.rollback_deployment,
    activationEpoch: Number(row.activation_epoch),
    basisPoints: Number(row.basis_points),
    stages: textInts(row.stages),
    stageIndex: Number(row.stage_index),
    taskSegment: row.task_segment,
    selectionEnabled: row.selection_enabled,
    status: row.status,
    actor: row.actor,
    events: events.rows.map((event) => ({
      action: event.action,
      actor: event.actor,
      activationEpoch: Number(event.activation_epoch),
      basisPoints: Number(event.basis_points),
      policyVersionId: event.policy_version_id,
      previousPolicyVersionId: event.previous_policy_version_id,
      rollbackDeployment: event.rollback_deployment,
    })),
  };
}

async function readProposal(client: PoolClient, proposalId: string): Promise<ProposalView | null> {
  const result = await client.query<{
    id: string;
    evidence_snapshot_id: string;
    task_segment: string;
    candidate_deployment: string;
    change_kind: ProposalView['changeKind'];
    gate_name: string;
    status: ProposalView['status'];
  }>(
    `SELECT proposal.id::text AS id, proposal.evidence_snapshot_id::text AS evidence_snapshot_id,
            proposal.task_segment, deployment.name AS candidate_deployment, proposal.change_kind,
            proposal.gate_name, proposal.status
     FROM routing_policy_proposals proposal
     JOIN model_deployments deployment
       ON deployment.tenant_id = proposal.tenant_id AND deployment.id = proposal.candidate_deployment_id
     WHERE proposal.id = $1`,
    [proposalId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    id: row.id,
    evidenceSnapshotId: row.evidence_snapshot_id,
    taskSegment: row.task_segment,
    candidateDeployment: row.candidate_deployment,
    changeKind: row.change_kind,
    gateName: row.gate_name,
    status: row.status,
    requiresShadow: true,
    requiresCanary: true,
  };
}

async function readEvent(client: PoolClient, idempotencyKey: string): Promise<{
  promotion_id: string | null;
  proposal_id: string | null;
  rollout_id: string;
  action: string;
  request_hash: string;
} | null> {
  const result = await client.query<{
    promotion_id: string | null;
    proposal_id: string | null;
    rollout_id: string;
    action: string;
    request_hash: string;
  }>(
    `SELECT promotion_id::text AS promotion_id, proposal_id::text AS proposal_id, rollout_id::text AS rollout_id,
            action, request_hash
     FROM routing_promotion_events
     WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  return result.rows[0] ?? null;
}

async function insertPromotionEvent(
  client: PoolClient,
  input: {
    tenantId: string;
    promotionId: string | null;
    proposalId: string | null;
    rolloutId: string;
    action: 'promote' | 'advance' | 'rollback' | 'reject';
    actor: PromotionActor;
    epoch: number;
    basisPoints: number;
    policyVersionId: string;
    previousPolicyVersionId: string | null;
    rollbackDeploymentId: string;
    idempotencyKey: string;
    requestHash: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO routing_promotion_events (
       tenant_id, promotion_id, proposal_id, rollout_id, action, actor, activation_epoch, basis_points,
       policy_version_id, previous_policy_version_id, rollback_deployment_id, gate_result, idempotency_key, request_hash
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{"pass":true}'::jsonb, $12, $13)`,
    [
      input.tenantId,
      input.promotionId,
      input.proposalId,
      input.rolloutId,
      input.action,
      input.actor,
      input.epoch,
      input.basisPoints,
      input.policyVersionId,
      input.previousPolicyVersionId,
      input.rollbackDeploymentId,
      input.idempotencyKey,
      input.requestHash,
    ],
  );
}

function presentAutomatic(row: {
  enabled: boolean;
  approved_candidate_ids: string[];
  quality_min_pass_rate: string;
  min_valid_pairs: number;
  noninferiority_margin: string;
  max_basis_points: number;
  require_guardrails: boolean;
  rollback_verified: boolean;
}): AutomaticPolicyView {
  return {
    enabled: row.enabled,
    approvedCandidateIds: textList(row.approved_candidate_ids),
    qualityMinPassRate: fixedDecimal(row.quality_min_pass_rate, 5),
    minValidPairs: Number(row.min_valid_pairs),
    noninferiorityMargin: fixedDecimal(row.noninferiority_margin, 5),
    maxBasisPoints: Number(row.max_basis_points),
    requireGuardrails: row.require_guardrails,
    rollbackVerified: row.rollback_verified,
  };
}

function parseAutomaticPolicy(value: unknown): AutomaticPolicyWrite {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidRequest('automaticPolicy', 'invalid_parameter', 'The automatic policy is invalid.');
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    'enabled',
    'approvedCandidateIds',
    'qualityMinPassRate',
    'minValidPairs',
    'noninferiorityMargin',
    'maxBasisPoints',
    'requireGuardrails',
    'rollbackVerified',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The automatic policy is invalid.');
  }
  if (typeof record.enabled !== 'boolean') throw invalidRequest('enabled', 'invalid_parameter', 'The enabled flag is invalid.');
  if (typeof record.requireGuardrails !== 'boolean') {
    throw invalidRequest('requireGuardrails', 'invalid_parameter', 'The guardrail flag is invalid.');
  }
  if (typeof record.rollbackVerified !== 'boolean') {
    throw invalidRequest('rollbackVerified', 'invalid_parameter', 'The rollback flag is invalid.');
  }
  if (!Array.isArray(record.approvedCandidateIds) || record.approvedCandidateIds.length > 8) {
    throw invalidRequest('approvedCandidateIds', 'invalid_parameter', 'The candidate set is invalid.');
  }
  const approvedCandidateIds = record.approvedCandidateIds.map((item) => {
    if (typeof item !== 'string' || !UUID.test(item)) {
      throw invalidRequest('approvedCandidateIds', 'invalid_parameter', 'The candidate set is invalid.');
    }
    return item.toLowerCase();
  });
  const qualityMinPassRate = rateField(record.qualityMinPassRate, 'qualityMinPassRate', true);
  const noninferiorityMargin = rateField(record.noninferiorityMargin, 'noninferiorityMargin', false);
  return {
    enabled: record.enabled,
    approvedCandidateIds,
    qualityMinPassRate,
    minValidPairs: integerField(record.minValidPairs, 'minValidPairs', 1, 10_000),
    noninferiorityMargin,
    maxBasisPoints: integerField(record.maxBasisPoints, 'maxBasisPoints', 1, 10_000),
    requireGuardrails: record.requireGuardrails,
    rollbackVerified: record.rollbackVerified,
  };
}

function parseStages(value: unknown): number[] {
  if (value === undefined) return [...DEFAULT_STAGES];
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw invalidRequest('stages', 'invalid_parameter', 'The stages are invalid.');
  }
  const stages: number[] = [];
  let previous = 0;
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1 || item > 10_000 || item <= previous) {
      throw invalidRequest('stages', 'invalid_parameter', 'The stages are invalid.');
    }
    previous = item;
    stages.push(item);
  }
  return stages;
}

function rateField(value: unknown, name: string, allowZero: boolean): string {
  if (typeof value !== 'string' || !RATE.test(value)) throw invalidRequest(name, 'invalid_parameter', 'The rate is invalid.');
  if (!allowZero && value === '0.00000') throw invalidRequest(name, 'invalid_parameter', 'The rate is invalid.');
  return value;
}

function integerField(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(name, 'invalid_parameter', 'The value is invalid.');
  }
  return value;
}

function sameStages(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function textInts(value: unknown): number[] {
  return textList(value).map((item) => Number(item));
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
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric.toFixed(places);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}
