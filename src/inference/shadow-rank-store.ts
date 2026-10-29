import type { Pool, PoolClient } from 'pg';
import { withTenant } from '../db/tenant-context.js';
import type { Logger } from '../logger.js';
import { proxyError } from './errors.js';
import { extractRequestFeatures, FEATURE_EXTRACTOR_VERSION, featureInputFromChat } from './request-features.js';
import { inputSizeBand } from './sample-selection.js';
import type { ResolvedRoute } from './resolve.js';
import {
  SHADOW_RANK_DEADLINE_MS,
  knownAttemptCost,
  medianStored,
  parseSimulateBody,
  rankShadow,
  type RankDeployment,
  type RankEvidence,
  type RankFeatures,
  type RankOutcome,
  type RankPolicy,
} from './shadow-rank.js';
import type { ChatRequest } from './validate.js';

export type ShadowRankingView = {
  requestId: string | null;
  policyVersionId: string | null;
  evidenceSnapshotIds: string[];
  baselineDeployment: string | null;
  recommendedDeployment: string | null;
  actualDeployment: string | null;
  routingMode: 'shadow' | 'bypass' | 'failed' | 'static';
  reasonCodes: string[];
  exclusions: Array<{ deployment: string; reason: string }>;
  failureReason: string | null;
  savingsKind: 'estimate';
  estimatedSavings: string | null;
  candidateCount: number;
  eligibleCount: number;
  cacheHit: boolean;
  computationMs: number;
  featureExtractorVersion: number;
};

export type ShadowMetricsView = {
  savingsKind: 'estimate';
  predictedSavings: string;
  predictedSavingsNote: 'estimate';
  candidateCount: number;
  decisionFailures: number;
  decisions: number;
  cacheHits: number;
  cacheHitRate: string | null;
};

type PolicyLoad = {
  versionId: string;
  baselineDeploymentId: string;
  candidateDeploymentIds: string[];
  qualityMinPassRate: number;
  qualityMinValidPairs: number;
  maxCostPerRequest: number;
  maxLatencyMs: number;
  taskSegments: string[];
};

export async function observeShadowRank(input: {
  pool: Pool;
  logger: Logger;
  tenantId: string;
  requestId: string;
  route: ResolvedRoute;
  request: ChatRequest;
  deadlineMs?: number;
}): Promise<void> {
  try {
    await withTenant(input.pool, input.tenantId, async (client) => {
      const policy = await loadShadowPolicy(client);
      if (policy === null) return;
      if (input.route.routedByAlias !== true) {
        await insertBypass(client, input.tenantId, input.requestId, input.route.deploymentId);
        return;
      }
      await rankAndStore(client, {
        tenantId: input.tenantId,
        requestId: input.requestId,
        actualDeploymentId: input.route.deploymentId,
        request: input.request,
        policy,
        deadlineMs: input.deadlineMs ?? SHADOW_RANK_DEADLINE_MS,
      });
    });
  } catch (error) {
    input.logger.error('shadow ranking failed', { name: error instanceof Error ? error.name : 'unknown' });
    await storeSanitizedFailure(input.pool, input.logger, input.tenantId, input.requestId, input.route.deploymentId);
  }
}

export async function simulateShadowRank(
  client: PoolClient,
  tenantId: string,
  body: unknown,
  deadlineMs = SHADOW_RANK_DEADLINE_MS,
): Promise<ShadowRankingView> {
  const parsed = parseSimulateBody(body);
  if (parsed.model !== 'auto') {
    return {
      requestId: null,
      policyVersionId: null,
      evidenceSnapshotIds: [],
      baselineDeployment: null,
      recommendedDeployment: null,
      actualDeployment: null,
      routingMode: 'bypass',
      reasonCodes: ['named_model'],
      exclusions: [],
      failureReason: null,
      savingsKind: 'estimate',
      estimatedSavings: null,
      candidateCount: 0,
      eligibleCount: 0,
      cacheHit: false,
      computationMs: 0,
      featureExtractorVersion: FEATURE_EXTRACTOR_VERSION,
    };
  }
  const policy = await loadShadowPolicy(client);
  if (policy === null) {
    return {
      requestId: null,
      policyVersionId: null,
      evidenceSnapshotIds: [],
      baselineDeployment: null,
      recommendedDeployment: null,
      actualDeployment: null,
      routingMode: 'static',
      reasonCodes: ['no_shadow_policy'],
      exclusions: [],
      failureReason: null,
      savingsKind: 'estimate',
      estimatedSavings: null,
      candidateCount: 0,
      eligibleCount: 0,
      cacheHit: false,
      computationMs: 0,
      featureExtractorVersion: FEATURE_EXTRACTOR_VERSION,
    };
  }
  const request = simulateRequest(parsed);
  try {
    const stored = await rankAndStore(client, {
      tenantId,
      requestId: null,
      actualDeploymentId: null,
      request,
      policy,
      deadlineMs,
    });
    return stored;
  } catch (error) {
    const reason = error instanceof Error && error.message === 'ranking_timeout' ? 'ranking_timeout' : 'ranking_failed';
    return insertFailure(client, tenantId, null, policy, reason, 0, null);
  }
}

export async function readShadowRanking(client: PoolClient, requestId: string): Promise<ShadowRankingView | null> {
  const result = await client.query<RankingRow>(
    `${RANKING_SQL} WHERE r.request_id = $1`,
    [requestId],
  );
  const row = result.rows[0];
  return row === undefined ? null : present(row);
}

export async function readShadowMetrics(client: PoolClient): Promise<ShadowMetricsView> {
  const result = await client.query<{
    decisions: number;
    decision_failures: number;
    candidate_count: number;
    cache_hits: number;
    predicted_savings: string;
  }>(
    `SELECT count(*)::int AS decisions,
            count(*) FILTER (WHERE failure_reason IS NOT NULL)::int AS decision_failures,
            coalesce(sum(candidate_count), 0)::int AS candidate_count,
            count(*) FILTER (WHERE cache_hit)::int AS cache_hits,
            coalesce(sum(estimated_savings), 0)::text AS predicted_savings
     FROM routing_shadow_rankings`,
  );
  const row = result.rows[0];
  const decisions = row?.decisions ?? 0;
  const cacheHits = row?.cache_hits ?? 0;
  return {
    savingsKind: 'estimate',
    predictedSavings: fixedDecimal(row?.predicted_savings ?? '0', 8),
    predictedSavingsNote: 'estimate',
    candidateCount: row?.candidate_count ?? 0,
    decisionFailures: row?.decision_failures ?? 0,
    decisions,
    cacheHits,
    cacheHitRate: decisions === 0 ? null : (cacheHits / decisions).toFixed(5),
  };
}

async function rankAndStore(
  client: PoolClient,
  input: {
    tenantId: string;
    requestId: string | null;
    actualDeploymentId: string | null;
    request: ChatRequest;
    policy: PolicyLoad;
    deadlineMs: number;
  },
): Promise<ShadowRankingView> {
  const started = Date.now();
  const deadlineAt = started + input.deadlineMs;
  if (input.deadlineMs <= 0 || started >= deadlineAt) {
    return insertFailure(client, input.tenantId, input.requestId, input.policy, 'ranking_timeout', 0, input.actualDeploymentId);
  }
  const features = featuresFrom(input.request);
  const loaded = await loadRankMaterial(client, input.policy, features);
  const outcome = rankShadow({
    tenantId: input.tenantId,
    nowMs: started,
    deadlineMs: deadlineAt,
    clock: () => Date.now(),
    features,
    policy: toRankPolicy(input.policy),
    deployments: loaded.deployments,
    evidence: loaded.evidence,
  });
  const computationMs = Math.min(600_000, Math.max(0, Date.now() - started));
  if (outcome.failureReason !== null) {
    return insertFailure(client, input.tenantId, input.requestId, input.policy, outcome.failureReason, computationMs, input.actualDeploymentId);
  }
  return insertOutcome(client, input.tenantId, input.requestId, input.actualDeploymentId, outcome, computationMs, loaded.names);
}

async function storeSanitizedFailure(
  pool: Pool,
  logger: Logger,
  tenantId: string,
  requestId: string,
  actualDeploymentId: string,
): Promise<void> {
  try {
    await withTenant(pool, tenantId, async (client) => {
      const policy = await loadShadowPolicy(client);
      if (policy === null) return;
      await insertFailure(client, tenantId, requestId, policy, 'ranking_failed', 0, actualDeploymentId);
    });
  } catch (error) {
    logger.error('shadow ranking failure was not stored', { name: error instanceof Error ? error.name : 'unknown' });
  }
}

async function loadShadowPolicy(client: PoolClient): Promise<PolicyLoad | null> {
  const result = await client.query<{
    version_id: string;
    baseline_deployment_id: string;
    candidate_deployment_ids: string[];
    quality_min_pass_rate: string;
    quality_min_valid_pairs: number;
    max_cost_per_request: string;
    max_latency_ms: number;
    task_segments: string[];
  }>(
    `SELECT a.version_id::text AS version_id,
            v.baseline_deployment_id::text AS baseline_deployment_id,
            v.candidate_deployment_ids::text[] AS candidate_deployment_ids,
            v.quality_min_pass_rate::text AS quality_min_pass_rate,
            v.quality_min_valid_pairs,
            v.max_cost_per_request::text AS max_cost_per_request,
            v.max_latency_ms,
            v.task_segments
     FROM routing_policy_activations a
     JOIN routing_policy_versions v ON v.tenant_id = a.tenant_id AND v.id = a.version_id
     WHERE a.alias = 'auto' AND a.status = 'shadow'
     LIMIT 1`,
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  return {
    versionId: row.version_id,
    baselineDeploymentId: row.baseline_deployment_id,
    candidateDeploymentIds: textList(row.candidate_deployment_ids),
    qualityMinPassRate: Number(row.quality_min_pass_rate),
    qualityMinValidPairs: Number(row.quality_min_valid_pairs),
    maxCostPerRequest: Number(row.max_cost_per_request),
    maxLatencyMs: Number(row.max_latency_ms),
    taskSegments: textList(row.task_segments),
  };
}

const EVIDENCE_ROW_CAP = 32;

async function loadRankMaterial(
  client: PoolClient,
  policy: PolicyLoad,
  features: RankFeatures,
): Promise<{ deployments: RankDeployment[]; evidence: RankEvidence[]; names: Map<string, string> }> {
  const ids = unique([policy.baselineDeploymentId, ...policy.candidateDeploymentIds]).slice(0, 9);
  const deployments = await client.query<{
    id: string;
    name: string;
    enabled: boolean;
    connection_enabled: boolean;
    validation_status: string;
    capabilities: string[] | null;
    context_limit: number | null;
  }>(
    `SELECT d.id::text AS id, d.name, d.enabled, c.enabled AS connection_enabled,
            d.validation_status, d.capabilities, d.context_limit
     FROM model_deployments d
     JOIN provider_connections c ON c.tenant_id = d.tenant_id AND c.id = d.connection_id
     WHERE d.id = ANY($1::uuid[])`,
    [ids],
  );
  const names = new Map(deployments.rows.map((row) => [row.id, row.name]));
  const snapshots = await client.query<{
    deployment_id: string;
    deployment_name: string;
    task_category: string;
    complexity: string;
    input_size_category: string;
    required_capabilities: string[] | null;
    freshness_seconds: number;
    snapshot_id: string;
    created_at: Date;
    matched_pairs: number;
    source_run_ids: string[] | null;
    status: RankEvidence['status'];
    wilson_lower: string | null;
  }>(
    `WITH newest AS (
       SELECT DISTINCT ON (d.id, v.task_category, v.complexity, v.input_size_category)
              d.id::text AS deployment_id, d.name AS deployment_name,
              v.task_category, v.complexity, v.input_size_category, v.required_capabilities,
              v.freshness_seconds, s.id::text AS snapshot_id, s.created_at, s.matched_pairs,
              s.source_run_ids::text[] AS source_run_ids, a.status, a.wilson_lower::text AS wilson_lower
       FROM qualification_profile_versions v
       JOIN model_deployments d ON d.tenant_id = v.tenant_id AND d.id = v.candidate_deployment_id
       JOIN evidence_snapshots s ON s.tenant_id = v.tenant_id AND s.profile_version_id = v.id
       JOIN evidence_candidate_assessments a ON a.tenant_id = s.tenant_id AND a.snapshot_id = s.id
       WHERE d.id = ANY($1::uuid[])
       ORDER BY d.id, v.task_category, v.complexity, v.input_size_category, s.created_at DESC
     )
     SELECT deployment_id, deployment_name, task_category, complexity, input_size_category,
            required_capabilities, freshness_seconds, snapshot_id, created_at, matched_pairs,
            source_run_ids, status, wilson_lower
     FROM newest
     ORDER BY (task_category = $2 AND complexity = $3 AND input_size_category = $4) DESC,
              (task_category = $2) DESC,
              created_at DESC
     LIMIT $5`,
    [ids, features.taskCategory, features.complexityEstimate, inputSizeBand(features.inputSize), EVIDENCE_ROW_CAP],
  );
  const runIds = unique(snapshots.rows.flatMap((row) => textList(row.source_run_ids))).slice(0, 256);
  const attempts = runIds.length === 0
    ? []
    : (
        await client.query<{
          run_id: string;
          challenger_deployment: string;
          cost_amount: string | null;
          cost_status: string | null;
          latency_ms: number | null;
        }>(
          `SELECT run_id::text AS run_id, challenger_deployment,
                  cost_amount::text AS cost_amount, cost_status, latency_ms
           FROM evaluation_attempts
           WHERE run_id = ANY($1::uuid[])
             AND status = 'completed'`,
          [runIds],
        )
      ).rows;
  const evidence: RankEvidence[] = snapshots.rows.map((row) => {
    const runs = textList(row.source_run_ids);
    const summary = summarizeAttempts(runs, row.deployment_name, attempts);
    return {
      snapshotId: row.snapshot_id,
      deploymentId: row.deployment_id,
      taskCategory: row.task_category,
      complexity: row.complexity,
      inputSizeCategory: row.input_size_category,
      requiredCapabilities: textList(row.required_capabilities),
      freshnessSeconds: Number(row.freshness_seconds),
      createdAtMs: row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at)),
      status: row.status,
      wilsonLower: row.wilson_lower === null ? null : Number(row.wilson_lower),
      matchedPairs: Number(row.matched_pairs),
      expectedCost: summary.cost,
      expectedLatencyMs: summary.latency,
    };
  });
  return {
    deployments: deployments.rows.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
      connectionEnabled: row.connection_enabled,
      validationStatus: row.validation_status,
      capabilities: textList(row.capabilities),
      contextLimit: row.context_limit,
    })),
    evidence,
    names,
  };
}

function summarizeAttempts(
  runIds: readonly string[],
  deploymentName: string,
  attempts: readonly {
    run_id: string;
    challenger_deployment: string;
    cost_amount: string | null;
    cost_status: string | null;
    latency_ms: number | null;
  }[],
): { cost: number | null; latency: number | null } {
  const rows = attempts.filter((row) => row.challenger_deployment === deploymentName && runIds.includes(row.run_id));
  if (rows.length === 0) return { cost: null, latency: null };
  const costs: number[] = [];
  const latencies: number[] = [];
  let costKnown = true;
  let latencyKnown = true;
  for (const row of rows) {
    const cost = knownAttemptCost(row.cost_amount, row.cost_status);
    if (cost === null) costKnown = false;
    else costs.push(cost);
    if (row.latency_ms === null) latencyKnown = false;
    else latencies.push(Number(row.latency_ms));
  }
  return {
    cost: costKnown ? medianStored(costs) : null,
    latency: latencyKnown ? medianStored(latencies) : null,
  };
}

async function insertBypass(client: PoolClient, tenantId: string, requestId: string, actualDeploymentId: string): Promise<void> {
  await client.query(
    `INSERT INTO routing_shadow_rankings (
       tenant_id, request_id, routing_mode, reason_codes, exclusions, failure_reason,
       savings_kind, candidate_count, eligible_count, cache_hit, computation_ms,
       feature_extractor_version, actual_deployment_id
     ) VALUES (
       $1, $2, 'bypass', ARRAY['named_model']::text[], '[]'::jsonb, NULL,
       'estimate', 0, 0, false, 0, $3, $4
     )
     ON CONFLICT (tenant_id, request_id) WHERE request_id IS NOT NULL DO NOTHING`,
    [tenantId, requestId, FEATURE_EXTRACTOR_VERSION, actualDeploymentId],
  );
}

async function insertOutcome(
  client: PoolClient,
  tenantId: string,
  requestId: string | null,
  actualDeploymentId: string | null,
  outcome: RankOutcome,
  computationMs: number,
  names: Map<string, string>,
): Promise<ShadowRankingView> {
  const exclusions = outcome.exclusions.slice(0, 8).map((item) => ({
    deployment: item.deployment,
    reason: item.reason,
  }));
  const result = await client.query<{ id: string }>(
    `INSERT INTO routing_shadow_rankings (
       tenant_id, request_id, policy_version_id, evidence_snapshot_ids,
       baseline_deployment_id, recommended_deployment_id, actual_deployment_id,
       routing_mode, reason_codes, exclusions, failure_reason, savings_kind, estimated_savings,
       candidate_count, eligible_count, cache_hit, computation_ms, feature_extractor_version
     ) VALUES (
       $1, $2, $3, $4::uuid[],
       $5, $6, $7,
       'shadow', $8::text[], $9::jsonb, NULL, 'estimate', $10,
       $11, $12, $13, $14, $15
     ) RETURNING id::text AS id`,
    [
      tenantId,
      requestId,
      outcome.policyVersionId,
      outcome.evidenceSnapshotIds,
      outcome.baselineDeploymentId,
      outcome.recommendedDeploymentId,
      actualDeploymentId,
      outcome.reasonCodes,
      JSON.stringify(exclusions),
      outcome.estimatedSavings,
      outcome.candidateCount,
      outcome.eligibleCount,
      outcome.cacheHit,
      computationMs,
      FEATURE_EXTRACTOR_VERSION,
    ],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw proxyError(500, 'server_error', 'internal_error', null, 'The request failed.');
  return viewFrom(id, requestId, outcome, actualDeploymentId, computationMs, names, exclusions);
}

async function insertFailure(
  client: PoolClient,
  tenantId: string,
  requestId: string | null,
  policy: PolicyLoad,
  reason: 'ranking_timeout' | 'ranking_failed',
  computationMs: number,
  actualDeploymentId: string | null,
): Promise<ShadowRankingView> {
  const candidateCount = Math.min(8, policy.candidateDeploymentIds.length);
  await client.query(
    `INSERT INTO routing_shadow_rankings (
       tenant_id, request_id, policy_version_id, baseline_deployment_id, actual_deployment_id,
       routing_mode, reason_codes, exclusions, failure_reason, savings_kind,
       candidate_count, eligible_count, cache_hit, computation_ms, feature_extractor_version
     ) VALUES (
       $1, $2, $3, $4, $5,
       'failed', ARRAY[$6]::text[], '[]'::jsonb, $6, 'estimate',
       $9, 0, false, $7, $8
     )
     ON CONFLICT (tenant_id, request_id) WHERE request_id IS NOT NULL DO NOTHING`,
    [
      tenantId,
      requestId,
      policy.versionId,
      policy.baselineDeploymentId,
      actualDeploymentId,
      reason,
      computationMs,
      FEATURE_EXTRACTOR_VERSION,
      candidateCount,
    ],
  );
  const ids = actualDeploymentId === null ? [policy.baselineDeploymentId] : [policy.baselineDeploymentId, actualDeploymentId];
  const names = await deploymentNames(client, ids);
  return {
    requestId,
    policyVersionId: policy.versionId,
    evidenceSnapshotIds: [],
    baselineDeployment: names.get(policy.baselineDeploymentId) ?? null,
    recommendedDeployment: null,
    actualDeployment: actualDeploymentId === null ? null : names.get(actualDeploymentId) ?? null,
    routingMode: 'failed',
    reasonCodes: [reason],
    exclusions: [],
    failureReason: reason,
    savingsKind: 'estimate',
    estimatedSavings: null,
    candidateCount,
    eligibleCount: 0,
    cacheHit: false,
    computationMs,
    featureExtractorVersion: FEATURE_EXTRACTOR_VERSION,
  };
}

function viewFrom(
  _id: string,
  requestId: string | null,
  outcome: RankOutcome,
  actualDeploymentId: string | null,
  computationMs: number,
  names: Map<string, string>,
  exclusions: Array<{ deployment: string; reason: string }>,
): ShadowRankingView {
  return {
    requestId,
    policyVersionId: outcome.policyVersionId,
    evidenceSnapshotIds: outcome.evidenceSnapshotIds,
    baselineDeployment: names.get(outcome.baselineDeploymentId) ?? null,
    recommendedDeployment: outcome.recommendedDeploymentId === null ? null : names.get(outcome.recommendedDeploymentId) ?? null,
    actualDeployment: actualDeploymentId === null ? null : names.get(actualDeploymentId) ?? null,
    routingMode: 'shadow',
    reasonCodes: outcome.reasonCodes,
    exclusions,
    failureReason: null,
    savingsKind: 'estimate',
    estimatedSavings: outcome.estimatedSavings,
    candidateCount: outcome.candidateCount,
    eligibleCount: outcome.eligibleCount,
    cacheHit: outcome.cacheHit,
    computationMs,
    featureExtractorVersion: FEATURE_EXTRACTOR_VERSION,
  };
}

async function deploymentNames(client: PoolClient, ids: readonly string[]): Promise<Map<string, string>> {
  const result = await client.query<{ id: string; name: string }>(
    `SELECT id::text AS id, name FROM model_deployments WHERE id = ANY($1::uuid[])`,
    [unique(ids)],
  );
  return new Map(result.rows.map((row) => [row.id, row.name]));
}

const RANKING_SQL = `SELECT r.request_id::text AS request_id,
            r.policy_version_id::text AS policy_version_id,
            r.evidence_snapshot_ids::text[] AS evidence_snapshot_ids,
            b.name AS baseline_deployment,
            c.name AS recommended_deployment,
            a.name AS actual_deployment,
            r.routing_mode, r.reason_codes, r.exclusions, r.failure_reason,
            r.savings_kind, r.estimated_savings::text AS estimated_savings,
            r.candidate_count, r.eligible_count, r.cache_hit, r.computation_ms,
            r.feature_extractor_version
     FROM routing_shadow_rankings r
     LEFT JOIN model_deployments b ON b.tenant_id = r.tenant_id AND b.id = r.baseline_deployment_id
     LEFT JOIN model_deployments c ON c.tenant_id = r.tenant_id AND c.id = r.recommended_deployment_id
     LEFT JOIN model_deployments a ON a.tenant_id = r.tenant_id AND a.id = r.actual_deployment_id`;

type RankingRow = {
  request_id: string | null;
  policy_version_id: string | null;
  evidence_snapshot_ids: string[] | null;
  baseline_deployment: string | null;
  recommended_deployment: string | null;
  actual_deployment: string | null;
  routing_mode: 'shadow' | 'bypass' | 'failed';
  reason_codes: string[];
  exclusions: unknown;
  failure_reason: string | null;
  savings_kind: 'estimate';
  estimated_savings: string | null;
  candidate_count: number;
  eligible_count: number;
  cache_hit: boolean;
  computation_ms: number;
  feature_extractor_version: number;
};

function present(row: RankingRow): ShadowRankingView {
  return {
    requestId: row.request_id,
    policyVersionId: row.policy_version_id,
    evidenceSnapshotIds: textList(row.evidence_snapshot_ids),
    baselineDeployment: row.baseline_deployment,
    recommendedDeployment: row.recommended_deployment,
    actualDeployment: row.actual_deployment,
    routingMode: row.routing_mode,
    reasonCodes: textList(row.reason_codes),
    exclusions: exclusionList(row.exclusions),
    failureReason: row.failure_reason,
    savingsKind: 'estimate',
    estimatedSavings: row.estimated_savings === null ? null : fixedDecimal(row.estimated_savings, 8),
    candidateCount: Number(row.candidate_count),
    eligibleCount: Number(row.eligible_count),
    cacheHit: row.cache_hit,
    computationMs: Number(row.computation_ms),
    featureExtractorVersion: Number(row.feature_extractor_version),
  };
}

function featuresFrom(request: ChatRequest): RankFeatures {
  const extracted = extractRequestFeatures(featureInputFromChat(request));
  const requested = Object.keys(request.optional).map((key) => (key === 'response_format' ? 'response_format_text' : key));
  const maxTokens = positive(request.optional.max_tokens) ?? positive(request.optional.max_completion_tokens);
  return {
    taskCategory: extracted.taskCategory,
    classificationSource: extracted.classificationSource,
    complexityEstimate: extracted.complexityEstimate,
    inputSize: extracted.inputSize,
    inputTokenEstimate: extracted.inputTokenEstimate,
    requestedCapabilities: requested,
    contextNeed: maxTokens ?? 1,
  };
}

function simulateRequest(parsed: {
  model: string;
  messages: Array<{ role: string; content: string }>;
  taskHint: string | null;
  maxTokens: number | null;
  stream: boolean;
}): ChatRequest {
  const optional: Record<string, unknown> = {};
  if (parsed.maxTokens !== null) optional.max_tokens = parsed.maxTokens;
  return {
    model: parsed.model,
    messages: parsed.messages.map((message) => ({ role: message.role as 'system' | 'user' | 'assistant', content: message.content })),
    stream: parsed.stream,
    includeUsage: false,
    taskHint: parsed.taskHint,
    optional,
  };
}

function toRankPolicy(policy: PolicyLoad): RankPolicy {
  return {
    versionId: policy.versionId,
    baselineDeploymentId: policy.baselineDeploymentId,
    candidateDeploymentIds: policy.candidateDeploymentIds,
    qualityMinPassRate: policy.qualityMinPassRate,
    qualityMinValidPairs: policy.qualityMinValidPairs,
    maxCostPerRequest: policy.maxCostPerRequest,
    maxLatencyMs: policy.maxLatencyMs,
    taskSegments: policy.taskSegments,
  };
}

function positive(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function textList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item));
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    if (value.length === 2) return [];
    return value.slice(1, -1).split(',');
  }
  return [];
}

function exclusionList(value: unknown): Array<{ deployment: string; reason: string }> {
  const rows = Array.isArray(value) ? value : [];
  const exclusions: Array<{ deployment: string; reason: string }> = [];
  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) continue;
    const record = row as Record<string, unknown>;
    if (typeof record.deployment !== 'string' || typeof record.reason !== 'string') continue;
    exclusions.push({ deployment: record.deployment, reason: record.reason });
  }
  return exclusions;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function fixedDecimal(value: string, places: number): string {
  const negative = value.startsWith('-');
  const raw = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = raw.split('.');
  return `${negative ? '-' : ''}${whole}.${fraction.padEnd(places, '0').slice(0, places)}`;
}
