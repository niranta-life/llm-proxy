import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { assignCohort, generatedRoutingKey, routingKeyDigest } from './canary-assignment.js';
import { ProxyError, proxyError } from './errors.js';
import { extractRequestFeatures, featureInputFromChat } from './request-features.js';
import { routeForDeployment, type DeploymentCandidate, type ResolvedRoute } from './resolve.js';
import { recommendPolicy, type PolicyLoad } from './shadow-rank-store.js';
import type { ChatRequest } from './validate.js';

export type SelectionReason =
  | 'selected'
  | 'baseline_fallback'
  | 'stage_held'
  | 'segment_mismatch'
  | 'selection_disabled'
  | 'rolled_back';

export type SelectionPlan = {
  skipCanary: boolean;
  route: ResolvedRoute;
  record: boolean;
  promotionId: string | null;
  policyVersionId: string | null;
  activationEpoch: number | null;
  taskSegment: string | null;
  baselineDeploymentId: string | null;
  selectedDeploymentId: string | null;
  reason: SelectionReason | null;
  expectedCost: string | null;
  routingKeyDigest: string | null;
};

type ServingRow = {
  id: string;
  policy_version_id: string;
  activation_epoch: number;
  basis_points: number;
  task_segment: string;
  selection_enabled: boolean;
  rollback_deployment_id: string;
  version_id: string;
  baseline_deployment_id: string;
  candidate_deployment_ids: string[];
  quality_min_pass_rate: string;
  quality_min_valid_pairs: number;
  max_cost_per_request: string;
  max_latency_ms: number;
  task_segments: string[];
};

export async function selectPromoted(input: {
  pool: Pool;
  logger: Logger;
  tenantId: string;
  route: ResolvedRoute;
  request: ChatRequest;
  routingKey: string | null;
  deployments: readonly DeploymentCandidate[];
}): Promise<SelectionPlan> {
  if (input.route.routedByAlias !== true || input.route.requestedModel !== 'auto') return idle(input.route);
  try {
    return await withTenant(input.pool, input.tenantId, (client) =>
      selectOnClient(client, input.tenantId, input.route, input.request, input.routingKey, input.deployments),
    );
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    input.logger.error('promotion selection was not read', {
      message: error instanceof Error ? error.message : 'unknown',
    });
    return idle(input.route);
  }
}

export async function recordSelection(
  client: PoolClient,
  tenantId: string,
  requestId: string,
  plan: SelectionPlan,
): Promise<void> {
  if (!plan.record || plan.promotionId === null || plan.policyVersionId === null || plan.activationEpoch === null) return;
  if (plan.taskSegment === null || plan.baselineDeploymentId === null || plan.selectedDeploymentId === null || plan.reason === null) return;
  await client.query(
    `INSERT INTO routing_selection_decisions (
       tenant_id, request_id, promotion_id, policy_version_id, activation_epoch, task_segment,
       baseline_deployment_id, selected_deployment_id, reason, expected_cost, routing_key_digest
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11)`,
    [
      tenantId,
      requestId,
      plan.promotionId,
      plan.policyVersionId,
      plan.activationEpoch,
      plan.taskSegment,
      plan.baselineDeploymentId,
      plan.selectedDeploymentId,
      plan.reason,
      plan.expectedCost,
      plan.routingKeyDigest,
    ],
  );
}

async function selectOnClient(
  client: PoolClient,
  tenantId: string,
  route: ResolvedRoute,
  request: ChatRequest,
  routingKey: string | null,
  deployments: readonly DeploymentCandidate[],
): Promise<SelectionPlan> {
  const loaded = await client.query<ServingRow>(
    `SELECT promotion.id::text AS id, promotion.policy_version_id::text AS policy_version_id,
            promotion.activation_epoch, promotion.basis_points, promotion.task_segment, promotion.selection_enabled,
            promotion.rollback_deployment_id::text AS rollback_deployment_id,
            version.id::text AS version_id, version.baseline_deployment_id::text AS baseline_deployment_id,
            version.candidate_deployment_ids::text[] AS candidate_deployment_ids,
            version.quality_min_pass_rate::text AS quality_min_pass_rate, version.quality_min_valid_pairs,
            version.max_cost_per_request::text AS max_cost_per_request, version.max_latency_ms, version.task_segments
     FROM routing_promotions promotion
     JOIN routing_policy_versions version
       ON version.tenant_id = promotion.tenant_id AND version.id = promotion.policy_version_id
     WHERE promotion.alias = 'auto' AND promotion.status = 'serving'
     LIMIT 1`,
  );
  const serving = loaded.rows[0];
  if (serving === undefined || serving.selection_enabled !== true) return idle(route);
  const features = extractRequestFeatures(featureInputFromChat(request));
  const digest = routingKey === null ? null : routingKeyDigest(routingKey);
  const base = {
    skipCanary: true,
    promotionId: serving.id,
    policyVersionId: serving.policy_version_id,
    activationEpoch: Number(serving.activation_epoch),
    taskSegment: features.taskCategory,
    baselineDeploymentId: serving.rollback_deployment_id,
    routingKeyDigest: digest,
  };
  if (features.taskCategory !== serving.task_segment) {
    return held(route, base, route.deploymentId, 'segment_mismatch', null);
  }
  const key = routingKey ?? generatedRoutingKey();
  const share = assignCohort({
    tenantId,
    alias: 'auto',
    policyVersionId: serving.policy_version_id,
    routingKey: key,
    basisPoints: Number(serving.basis_points),
  });
  if (share !== 'canary') return held(route, base, route.deploymentId, 'stage_held', null);
  if (digest !== null) {
    const pinned = await readPin(client, serving.id, digest, serving.task_segment, deployments, route);
    if (pinned !== null) return held(pinned.route, base, pinned.route.deploymentId, 'selected', pinned.expectedCost);
  }
  const policy: PolicyLoad = {
    versionId: serving.version_id,
    baselineDeploymentId: serving.baseline_deployment_id,
    candidateDeploymentIds: textList(serving.candidate_deployment_ids),
    qualityMinPassRate: Number(serving.quality_min_pass_rate),
    qualityMinValidPairs: Number(serving.quality_min_valid_pairs),
    maxCostPerRequest: Number(serving.max_cost_per_request),
    maxLatencyMs: Number(serving.max_latency_ms),
    taskSegments: textList(serving.task_segments),
  };
  const live = await liveMedians(client, policy.candidateDeploymentIds);
  const recommended = await recommendPolicy(client, tenantId, policy, request, live);
  const chosenId = recommended.outcome.failureReason === null ? recommended.outcome.recommendedDeploymentId : null;
  const chosen = chosenId === null ? undefined : deployments.find((item) => item.id === chosenId);
  if (chosen !== undefined && (await assignmentQualified(client, chosen.id, features.taskCategory))) {
    const selected = routeForDeployment(route.requestedModel, chosen, true, route.fallbackPolicy ?? null);
    const cost = recommended.expectedCost === null ? null : recommended.expectedCost.toFixed(8);
    if (digest !== null) await rememberPin(client, tenantId, serving.id, digest, chosen.id);
    return held(selected, base, chosen.id, 'selected', cost);
  }
  const baseline = deployments.find((item) => item.id === route.deploymentId);
  if (baseline === undefined || !baselinePermitted(baseline, route)) {
    throw proxyError(409, 'invalid_request_error', 'baseline_unavailable', 'model', 'No qualified candidate is available.');
  }
  return held(route, base, route.deploymentId, 'baseline_fallback', null);
}

function held(
  route: ResolvedRoute,
  base: {
    skipCanary: boolean;
    promotionId: string;
    policyVersionId: string;
    activationEpoch: number;
    taskSegment: string;
    baselineDeploymentId: string;
    routingKeyDigest: string | null;
  },
  selectedDeploymentId: string,
  reason: SelectionReason,
  expectedCost: string | null,
): SelectionPlan {
  return {
    ...base,
    route,
    record: true,
    selectedDeploymentId,
    reason,
    expectedCost,
  };
}

async function readPin(
  client: PoolClient,
  promotionId: string,
  digest: string,
  taskSegment: string,
  deployments: readonly DeploymentCandidate[],
  route: ResolvedRoute,
): Promise<{ route: ResolvedRoute; expectedCost: string | null } | null> {
  const pin = await client.query<{ deployment_id: string }>(
    `SELECT deployment_id::text AS deployment_id
     FROM routing_selection_pins
     WHERE promotion_id = $1 AND routing_key_digest = $2`,
    [promotionId, digest],
  );
  const deploymentId = pin.rows[0]?.deployment_id;
  if (deploymentId === undefined) return null;
  const deployment = deployments.find((item) => item.id === deploymentId);
  if (deployment === undefined || !deployment.enabled || !deployment.connectionEnabled || deployment.validationStatus !== 'validated_live') {
    return null;
  }
  if (!(await assignmentQualified(client, deploymentId, taskSegment))) return null;
  return { route: routeForDeployment(route.requestedModel, deployment, true, route.fallbackPolicy ?? null), expectedCost: null };
}

async function assignmentQualified(client: PoolClient, deploymentId: string, taskSegment: string): Promise<boolean> {
  const evidence = await client.query<{ status: string; fresh: boolean; model_ok: boolean; config_ok: boolean }>(
    `SELECT assessment.status,
            (snapshot.created_at + make_interval(secs => profile.freshness_seconds) > statement_timestamp()) AS fresh,
            (profile.model_version = deployment.upstream_model) AS model_ok,
            (profile.deployment_config_version = deployment.config_version) AS config_ok
     FROM qualification_profile_versions profile
     JOIN model_deployments deployment ON deployment.tenant_id = profile.tenant_id AND deployment.id = profile.candidate_deployment_id
     JOIN evidence_snapshots snapshot ON snapshot.tenant_id = profile.tenant_id AND snapshot.profile_version_id = profile.id
     JOIN evidence_candidate_assessments assessment
       ON assessment.tenant_id = snapshot.tenant_id AND assessment.snapshot_id = snapshot.id
     WHERE profile.candidate_deployment_id = $1 AND profile.task_category = $2
     ORDER BY snapshot.created_at DESC, snapshot.id DESC
     LIMIT 1`,
    [deploymentId, taskSegment],
  );
  const newest = evidence.rows[0];
  return newest !== undefined && newest.status === 'qualified' && newest.fresh === true && newest.model_ok === true && newest.config_ok === true;
}

async function rememberPin(
  client: PoolClient,
  tenantId: string,
  promotionId: string,
  digest: string,
  deploymentId: string,
): Promise<void> {
  await client.query(
    `INSERT INTO routing_selection_pins (tenant_id, promotion_id, routing_key_digest, deployment_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING`,
    [tenantId, promotionId, digest, deploymentId],
  );
}

async function liveMedians(
  client: PoolClient,
  deploymentIds: readonly string[],
): Promise<Map<string, { cost: number | null; latencyMs: number | null }>> {
  const result = await client.query<{ deployment_id: string; median_cost: string | null; median_latency: string | null }>(
    `SELECT attempt.deployment_id::text AS deployment_id,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY cost.amount)::text AS median_cost,
            percentile_disc(0.5) WITHIN GROUP (ORDER BY attempt.duration_ms)::text AS median_latency
     FROM model_attempts attempt
     LEFT JOIN attempt_costs cost
       ON cost.tenant_id = attempt.tenant_id AND cost.attempt_id = attempt.id
      AND cost.cost_status IN ('estimated', 'provisional', 'reconciled')
     WHERE attempt.deployment_id = ANY($1::uuid[])
     GROUP BY attempt.deployment_id`,
    [deploymentIds],
  );
  const live = new Map<string, { cost: number | null; latencyMs: number | null }>();
  for (const row of result.rows) {
    live.set(row.deployment_id, {
      cost: row.median_cost === null ? null : Number(row.median_cost),
      latencyMs: row.median_latency === null ? null : Number(row.median_latency),
    });
  }
  return live;
}

function baselinePermitted(deployment: DeploymentCandidate, route: ResolvedRoute): boolean {
  if (!deployment.enabled || !deployment.connectionEnabled || deployment.validationStatus !== 'validated_live') return false;
  const fallback = route.fallbackPolicy ?? null;
  if (fallback === null || !fallback.enabled) return true;
  if (!fallback.allowedProviders.includes(deployment.provider)) return false;
  if (deployment.dataCollection === null || deployment.dataCollection !== fallback.dataCollection) return false;
  if (fallback.allowedRegions.length > 0) {
    if (deployment.location === null || !fallback.allowedRegions.includes(deployment.location)) return false;
  }
  return true;
}

function idle(route: ResolvedRoute): SelectionPlan {
  return {
    skipCanary: false,
    route,
    record: false,
    promotionId: null,
    policyVersionId: null,
    activationEpoch: null,
    taskSegment: null,
    baselineDeploymentId: null,
    selectedDeploymentId: null,
    reason: null,
    expectedCost: null,
    routingKeyDigest: null,
  };
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  return [];
}
