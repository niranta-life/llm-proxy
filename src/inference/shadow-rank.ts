import { createHash } from 'node:crypto';
import { invalidRequest } from './errors.js';
import { inputSizeBand } from './sample-selection.js';
import { isTaskCategory } from './task-categories.js';

export const SHADOW_CANDIDATE_CAP = 8;
export const SHADOW_RANK_DEADLINE_MS = 250;
export const SHADOW_CACHE_CAP = 128;

export const RANK_REASONS = [
  'lowest_qualified_cost',
  'latency_tie_break',
  'quality_failed',
  'unauthorized',
  'capability_absent',
  'context_exceeded',
  'evidence_stale',
  'task_unmatched',
  'unknown_complexity',
  'cost_unknown',
  'latency_exceeded',
  'cost_exceeded',
  'baseline_fallback',
  'named_model',
  'ranking_timeout',
  'ranking_failed',
  'no_shadow_policy',
] as const;

export type RankReason = (typeof RANK_REASONS)[number];

const KNOWN_COST = new Set(['estimated', 'provisional', 'reconciled']);
const CACHE = new Map<string, RankOutcome>();

export type RankFeatures = {
  taskCategory: string;
  classificationSource: 'caller_hint' | 'rules' | 'unknown';
  complexityEstimate: 'low' | 'medium' | 'high';
  inputSize: number;
  inputTokenEstimate: number;
  requestedCapabilities: readonly string[];
  contextNeed: number;
};

export type RankPolicy = {
  versionId: string;
  baselineDeploymentId: string;
  candidateDeploymentIds: readonly string[];
  qualityMinPassRate: number;
  qualityMinValidPairs: number;
  maxCostPerRequest: number;
  maxLatencyMs: number;
  taskSegments: readonly string[];
};

export type RankDeployment = {
  id: string;
  name: string;
  enabled: boolean;
  connectionEnabled: boolean;
  validationStatus: string;
  capabilities: readonly string[];
  contextLimit: number | null;
};

export type RankEvidence = {
  snapshotId: string;
  deploymentId: string;
  taskCategory: string;
  complexity: string;
  inputSizeCategory: string;
  requiredCapabilities: readonly string[];
  freshnessSeconds: number;
  createdAtMs: number;
  status: 'qualified' | 'unqualified' | 'inconclusive' | 'invalidated';
  wilsonLower: number | null;
  matchedPairs: number;
  expectedCost: number | null;
  expectedLatencyMs: number | null;
};

export type RankExclusion = {
  deploymentId: string;
  deployment: string;
  reason: RankReason;
};

export type RankOutcome = {
  recommendedDeploymentId: string | null;
  baselineDeploymentId: string;
  policyVersionId: string;
  evidenceSnapshotIds: string[];
  reasonCodes: RankReason[];
  exclusions: RankExclusion[];
  candidateCount: number;
  eligibleCount: number;
  estimatedSavings: string | null;
  savingsKind: 'estimate';
  failureReason: 'ranking_timeout' | 'ranking_failed' | null;
  cacheHit: boolean;
};

export function resetShadowRankCache(): void {
  CACHE.clear();
}

export function rankShadow(input: {
  tenantId: string;
  nowMs: number;
  deadlineMs: number;
  clock?: () => number;
  features: RankFeatures;
  policy: RankPolicy;
  deployments: readonly RankDeployment[];
  evidence: readonly RankEvidence[];
}): RankOutcome {
  const boundedIds = input.policy.candidateDeploymentIds.slice(0, SHADOW_CANDIDATE_CAP);
  const base = blank(input.policy, boundedIds.length);
  const clock = input.clock ?? (() => input.nowMs);
  if (input.nowMs >= input.deadlineMs || clock() >= input.deadlineMs) return fail(base, 'ranking_timeout');
  const key = cacheKey(input.tenantId, input.nowMs, input.features, input.policy, boundedIds, input.deployments, input.evidence);
  const cached = CACHE.get(key);
  if (cached !== undefined) return { ...cached, exclusions: cached.exclusions.map((item) => ({ ...item })), evidenceSnapshotIds: [...cached.evidenceSnapshotIds], reasonCodes: [...cached.reasonCodes], cacheHit: true };
  const outcome = decide({ ...input, clock }, boundedIds, base);
  if (outcome.failureReason === null) remember(key, outcome);
  return outcome;
}

function decide(
  input: {
    nowMs: number;
    deadlineMs: number;
    clock: () => number;
    features: RankFeatures;
    policy: RankPolicy;
    deployments: readonly RankDeployment[];
    evidence: readonly RankEvidence[];
  },
  boundedIds: readonly string[],
  base: RankOutcome,
): RankOutcome {
  if (!input.policy.taskSegments.includes(input.features.taskCategory)) {
    return { ...base, reasonCodes: ['task_unmatched'] };
  }
  if (input.features.classificationSource === 'unknown') {
    return { ...base, reasonCodes: ['unknown_complexity'] };
  }
  const byId = new Map(input.deployments.map((item) => [item.id, item]));
  const exclusions: RankExclusion[] = [];
  const eligible: Array<{ id: string; cost: number; latency: number; snapshotId: string }> = [];
  const usedSnapshots: string[] = [];
  for (const deploymentId of boundedIds) {
    if (input.clock() >= input.deadlineMs) return fail(base, 'ranking_timeout');
    const deployment = byId.get(deploymentId);
    if (
      deployment === undefined ||
      !deployment.enabled ||
      !deployment.connectionEnabled ||
      deployment.validationStatus !== 'validated_live'
    ) {
      exclusions.push({
        deploymentId,
        deployment: deployment?.name ?? deploymentId,
        reason: 'unauthorized',
      });
      continue;
    }
    if (!covers(deployment.capabilities, input.features.requestedCapabilities)) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'capability_absent' });
      continue;
    }
    if (deployment.contextLimit === null || deployment.contextLimit < input.features.contextNeed) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'context_exceeded' });
      continue;
    }
    const matched = newestMatch(input.evidence, deploymentId, input.features);
    if (matched === null) {
      const sameTask = input.evidence.some(
        (item) => item.deploymentId === deploymentId && item.taskCategory === input.features.taskCategory,
      );
      exclusions.push({
        deploymentId,
        deployment: deployment.name,
        reason: sameTask ? 'unknown_complexity' : 'task_unmatched',
      });
      continue;
    }
    usedSnapshots.push(matched.snapshotId);
    if (!covers(deployment.capabilities, matched.requiredCapabilities)) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'capability_absent' });
      continue;
    }
    if (input.nowMs - matched.createdAtMs > matched.freshnessSeconds * 1000) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'evidence_stale' });
      continue;
    }
    if (!qualified(matched, input.policy)) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'quality_failed' });
      continue;
    }
    if (matched.expectedCost === null) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'cost_unknown' });
      continue;
    }
    if (matched.expectedCost > input.policy.maxCostPerRequest) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'cost_exceeded' });
      continue;
    }
    if (matched.expectedLatencyMs === null || matched.expectedLatencyMs > input.policy.maxLatencyMs) {
      exclusions.push({ deploymentId, deployment: deployment.name, reason: 'latency_exceeded' });
      continue;
    }
    eligible.push({
      id: deploymentId,
      cost: matched.expectedCost,
      latency: matched.expectedLatencyMs,
      snapshotId: matched.snapshotId,
    });
  }
  base.exclusions = exclusions.slice(0, SHADOW_CANDIDATE_CAP);
  base.evidenceSnapshotIds = unique(usedSnapshots).slice(0, SHADOW_CANDIDATE_CAP);
  base.eligibleCount = eligible.length;
  if (eligible.length === 0) {
    base.reasonCodes = ['baseline_fallback'];
    return base;
  }
  eligible.sort((left, right) => costKey(left.cost) - costKey(right.cost) || left.latency - right.latency || left.id.localeCompare(right.id));
  const winner = eligible[0];
  if (winner === undefined) {
    base.reasonCodes = ['baseline_fallback'];
    return base;
  }
  const tied = eligible.find((item) => item.id !== winner.id && costKey(item.cost) === costKey(winner.cost));
  const reasons: RankReason[] = ['lowest_qualified_cost'];
  if (tied !== undefined && tied.latency !== winner.latency) reasons.push('latency_tie_break');
  base.recommendedDeploymentId = winner.id;
  base.reasonCodes = reasons;
  base.estimatedSavings = savingsBetween(input, winner.cost);
  if (!base.evidenceSnapshotIds.includes(winner.snapshotId)) {
    base.evidenceSnapshotIds = [winner.snapshotId, ...base.evidenceSnapshotIds].slice(0, SHADOW_CANDIDATE_CAP);
  }
  return base;
}

export function medianStored(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid];
  if (upper === undefined) return null;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[mid - 1];
  if (lower === undefined) return upper;
  return (lower + upper) / 2;
}

export function knownAttemptCost(amount: string | null, status: string | null): number | null {
  if (amount === null || status === null || !KNOWN_COST.has(status)) return null;
  const value = Number(amount);
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

export function parseSimulateBody(body: unknown): {
  model: string;
  messages: Array<{ role: string; content: string }>;
  taskHint: string | null;
  maxTokens: number | null;
  stream: boolean;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The simulate body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set(['model', 'messages', 'task', 'max_tokens', 'stream']);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The simulate body is invalid.');
  }
  if (typeof record.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(record.model)) {
    throw invalidRequest('model', 'invalid_parameter', 'model is invalid.');
  }
  if (!Array.isArray(record.messages) || record.messages.length < 1 || record.messages.length > 8) {
    throw invalidRequest('messages', 'invalid_parameter', 'messages is invalid.');
  }
  let total = 0;
  const messages = record.messages.map((item) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw invalidRequest('messages', 'invalid_parameter', 'messages is invalid.');
    }
    const message = item as Record<string, unknown>;
    if (message.role !== 'system' && message.role !== 'user' && message.role !== 'assistant') {
      throw invalidRequest('messages', 'invalid_parameter', 'messages is invalid.');
    }
    if (typeof message.content !== 'string' || message.content.length > 8000) {
      throw invalidRequest('messages', 'invalid_parameter', 'messages is invalid.');
    }
    total += message.content.length;
    return { role: message.role, content: message.content };
  });
  if (total > 16_000) throw invalidRequest('messages', 'invalid_parameter', 'messages is invalid.');
  let taskHint: string | null = null;
  if (record.task !== undefined) {
    if (typeof record.task !== 'string' || !isTaskCategory(record.task)) {
      throw invalidRequest('task', 'invalid_parameter', 'task is invalid.');
    }
    taskHint = record.task;
  }
  let maxTokens: number | null = null;
  if (record.max_tokens !== undefined) {
    if (typeof record.max_tokens !== 'number' || !Number.isInteger(record.max_tokens) || record.max_tokens < 1 || record.max_tokens > 1_000_000) {
      throw invalidRequest('max_tokens', 'invalid_parameter', 'max_tokens is invalid.');
    }
    maxTokens = record.max_tokens;
  }
  const stream = record.stream === true;
  return { model: record.model, messages, taskHint, maxTokens, stream };
}

function qualified(evidence: RankEvidence, policy: RankPolicy): boolean {
  if (evidence.status !== 'qualified' || evidence.wilsonLower === null) return false;
  if (evidence.wilsonLower < policy.qualityMinPassRate) return false;
  return evidence.matchedPairs >= policy.qualityMinValidPairs;
}

function newestMatch(evidence: readonly RankEvidence[], deploymentId: string, features: RankFeatures): RankEvidence | null {
  const band = inputSizeBand(features.inputSize);
  let selected: RankEvidence | null = null;
  for (const item of evidence) {
    if (item.deploymentId !== deploymentId) continue;
    if (item.taskCategory !== features.taskCategory) continue;
    if (item.complexity !== features.complexityEstimate) continue;
    if (item.inputSizeCategory !== band) continue;
    if (selected === null || item.createdAtMs > selected.createdAtMs) selected = item;
  }
  return selected;
}

function savingsBetween(
  input: { nowMs: number; features: RankFeatures; policy: RankPolicy; evidence: readonly RankEvidence[] },
  winnerCost: number,
): string | null {
  const baseline = newestMatch(input.evidence, input.policy.baselineDeploymentId, input.features);
  if (baseline === null || baseline.expectedCost === null) return null;
  return (baseline.expectedCost - winnerCost).toFixed(8);
}

function covers(have: readonly string[], need: readonly string[]): boolean {
  return need.every((item) => have.includes(item));
}

function blank(policy: RankPolicy, candidateCount: number): RankOutcome {
  return {
    recommendedDeploymentId: null,
    baselineDeploymentId: policy.baselineDeploymentId,
    policyVersionId: policy.versionId,
    evidenceSnapshotIds: [],
    reasonCodes: ['baseline_fallback'],
    exclusions: [],
    candidateCount,
    eligibleCount: 0,
    estimatedSavings: null,
    savingsKind: 'estimate',
    failureReason: null,
    cacheHit: false,
  };
}

function fail(base: RankOutcome, reason: 'ranking_timeout' | 'ranking_failed'): RankOutcome {
  return {
    ...base,
    recommendedDeploymentId: null,
    reasonCodes: [reason],
    exclusions: [],
    eligibleCount: 0,
    estimatedSavings: null,
    failureReason: reason,
    cacheHit: false,
  };
}

function remember(key: string, outcome: RankOutcome): void {
  if (CACHE.size >= SHADOW_CACHE_CAP) {
    const oldest = CACHE.keys().next().value;
    if (oldest !== undefined) CACHE.delete(oldest);
  }
  CACHE.set(key, {
    ...outcome,
    exclusions: outcome.exclusions.map((item) => ({ ...item })),
    evidenceSnapshotIds: [...outcome.evidenceSnapshotIds],
    reasonCodes: [...outcome.reasonCodes],
    cacheHit: false,
  });
}

function cacheKey(
  tenantId: string,
  nowMs: number,
  features: RankFeatures,
  policy: RankPolicy,
  candidateIds: readonly string[],
  deployments: readonly RankDeployment[],
  evidence: readonly RankEvidence[],
): string {
  const byId = new Map(deployments.map((item) => [item.id, item]));
  const gates = candidateIds.map((id) => {
    const item = byId.get(id);
    if (item === undefined) return { id, present: false };
    return {
      id,
      present: true,
      enabled: item.enabled,
      connectionEnabled: item.connectionEnabled,
      validationStatus: item.validationStatus,
      capabilities: [...item.capabilities].sort(),
      contextLimit: item.contextLimit,
    };
  });
  const versions = evidence
    .map((item) => {
      const stale = nowMs - item.createdAtMs > item.freshnessSeconds * 1000;
      return `${item.snapshotId}:${item.createdAtMs}:${item.freshnessSeconds}:${stale ? 1 : 0}:${item.status}:${item.expectedCost ?? ''}:${item.expectedLatencyMs ?? ''}`;
    })
    .sort();
  const body = JSON.stringify({
    tenantId,
    policy: policy.versionId,
    candidates: candidateIds,
    gates,
    task: features.taskCategory,
    source: features.classificationSource,
    complexity: features.complexityEstimate,
    band: inputSizeBand(features.inputSize),
    tokens: features.inputTokenEstimate,
    need: features.contextNeed,
    capabilities: [...features.requestedCapabilities].sort(),
    floor: policy.qualityMinPassRate,
    pairs: policy.qualityMinValidPairs,
    maxCost: policy.maxCostPerRequest,
    maxLatency: policy.maxLatencyMs,
    segments: [...policy.taskSegments].sort(),
    versions,
  });
  return createHash('sha256').update(body).digest('hex');
}

function costKey(value: number): number {
  return Math.round(value * 100_000_000);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
