import { wilsonInterval } from './evaluation-report.js';

export const GUARDRAIL_KINDS = [
  'absolute_failure',
  'relative_failure',
  'latency',
  'spending',
  'capability',
  'deterministic_quality',
  'quality_regression',
] as const;

export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

export const CONSERVATIVE_DEFAULTS = {
  minSamples: 30,
  windowSeconds: 3_600,
  maturitySeconds: 300,
  maxMissingFraction: 0.2,
  margin: 0.05,
} as const;

const FAILURE_SIGNALS = [
  'error_rate',
  'timeout_rate',
  'incomplete_stream_rate',
  'retry_rate',
  'fallback_rate',
] as const;

const QUALITY_SIGNALS = ['schema_valid', 'correctness', 'task_success', 'evaluation_quality'] as const;

export type GuardrailRule = {
  id: string;
  kind: GuardrailKind;
  signal: string;
  threshold: number;
  margin: number;
  minSamples: number;
  windowSeconds: number;
  maturitySeconds: number;
  maxMissingFraction: number;
};

export type CohortTotals = {
  cohort: 'baseline' | 'canary';
  assignments: number;
  executions: number;
  errorRequests: number;
  timeoutRequests: number;
  incompleteStreamRequests: number;
  retryRequests: number;
  fallbackRequests: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  latencySamples: number;
  costSum: number;
  costSamples: number;
  completedCostSum: number;
  completedRequests: number;
  providerSuccesses: number;
  schemaPasses: number;
  schemaFailures: number;
  schemaUnknown: number;
  schemaMature: number;
  schemaMissing: number;
  schemaImmature: number;
  taskSuccesses: number;
  taskFailures: number;
  taskUnknown: number;
  taskMature: number;
  taskMissing: number;
  taskImmature: number;
  correctnessSuccesses: number;
  correctnessFailures: number;
  correctnessUnknown: number;
  correctnessMature: number;
  correctnessMissing: number;
  correctnessImmature: number;
  evaluationPasses: number;
  evaluationFails: number;
  evaluationUnknown: number;
};

export type CohortSnapshot = {
  cohorts: CohortTotals[];
  capabilityViolations: number;
};

export type DecisionReason =
  | 'violation'
  | 'insufficient_samples'
  | 'immature'
  | 'missing_feedback'
  | 'inconclusive'
  | 'within_gate'
  | 'no_rule';

export type GuardrailDecision = {
  action: 'stop' | 'hold';
  ruleId: string | null;
  kind: string;
  signal: string;
  reason: DecisionReason;
  detail: Record<string, number | null>;
};

type QualityCounts = {
  successes: number;
  failures: number;
  unknown: number;
  mature: number;
  missing: number;
  immature: number;
};

export function isGuardrailKind(value: string): value is GuardrailKind {
  return (GUARDRAIL_KINDS as readonly string[]).includes(value);
}

export function signalAllowed(kind: GuardrailKind, signal: string): boolean {
  if (kind === 'absolute_failure' || kind === 'relative_failure') {
    return (FAILURE_SIGNALS as readonly string[]).includes(signal);
  }
  if (kind === 'latency') return signal === 'latency_p95';
  if (kind === 'spending') return signal === 'cost_sum';
  if (kind === 'capability') return signal === 'capability_violation';
  if (kind === 'deterministic_quality') {
    return signal === 'schema_valid' || signal === 'correctness' || signal === 'task_success';
  }
  return (QUALITY_SIGNALS as readonly string[]).includes(signal) && signal !== 'schema_valid';
}

export function emptyCohort(cohort: 'baseline' | 'canary'): CohortTotals {
  return {
    cohort,
    assignments: 0,
    executions: 0,
    errorRequests: 0,
    timeoutRequests: 0,
    incompleteStreamRequests: 0,
    retryRequests: 0,
    fallbackRequests: 0,
    latencyP50Ms: null,
    latencyP95Ms: null,
    latencySamples: 0,
    costSum: 0,
    costSamples: 0,
    completedCostSum: 0,
    completedRequests: 0,
    providerSuccesses: 0,
    schemaPasses: 0,
    schemaFailures: 0,
    schemaUnknown: 0,
    schemaMature: 0,
    schemaMissing: 0,
    schemaImmature: 0,
    taskSuccesses: 0,
    taskFailures: 0,
    taskUnknown: 0,
    taskMature: 0,
    taskMissing: 0,
    taskImmature: 0,
    correctnessSuccesses: 0,
    correctnessFailures: 0,
    correctnessUnknown: 0,
    correctnessMature: 0,
    correctnessMissing: 0,
    correctnessImmature: 0,
    evaluationPasses: 0,
    evaluationFails: 0,
    evaluationUnknown: 0,
  };
}

export function decideGuardrails(rules: readonly GuardrailRule[], snapshot: CohortSnapshot): GuardrailDecision {
  if (rules.length === 0) {
    return { action: 'hold', ruleId: null, kind: 'none', signal: 'none', reason: 'no_rule', detail: {} };
  }
  let last = hold(rules[0]!, 'within_gate', {});
  for (const rule of rules) {
    const decision = decideRule(rule, snapshot);
    if (decision.action === 'stop') return decision;
    last = decision;
  }
  return last;
}

export function decideRule(rule: GuardrailRule, snapshot: CohortSnapshot): GuardrailDecision {
  if (rule.kind === 'capability') return decideCapability(rule, snapshot);
  const canary = snapshot.cohorts.find((row) => row.cohort === 'canary');
  const baseline = snapshot.cohorts.find((row) => row.cohort === 'baseline');
  if (canary === undefined) {
    return hold(rule, 'insufficient_samples', { samples: 0, minSamples: rule.minSamples });
  }
  if (rule.kind === 'absolute_failure' || rule.kind === 'relative_failure') {
    return decideFailure(rule, canary, baseline);
  }
  if (rule.kind === 'latency') return decideLatency(rule, canary);
  if (rule.kind === 'spending') return decideSpending(rule, canary);
  return decideQuality(rule, canary, baseline);
}

function decideCapability(rule: GuardrailRule, snapshot: CohortSnapshot): GuardrailDecision {
  const violations = snapshot.capabilityViolations;
  if (violations < rule.minSamples) {
    return hold(rule, 'insufficient_samples', { capabilityViolations: violations, minSamples: rule.minSamples });
  }
  if (violations >= rule.threshold) {
    return stop(rule, { capabilityViolations: violations, threshold: rule.threshold });
  }
  return hold(rule, 'within_gate', { capabilityViolations: violations, threshold: rule.threshold });
}

function decideFailure(
  rule: GuardrailRule,
  canary: CohortTotals,
  baseline: CohortTotals | undefined,
): GuardrailDecision {
  const samples = canary.executions;
  const failures = failureCount(canary, rule.signal);
  if (samples < rule.minSamples) {
    return hold(rule, 'insufficient_samples', { samples, failures, minSamples: rule.minSamples });
  }
  const rate = failures / samples;
  if (rule.kind === 'absolute_failure') {
    if (rate >= rule.threshold) return stop(rule, { rate, failures, samples, threshold: rule.threshold });
    return hold(rule, 'within_gate', { rate, failures, samples, threshold: rule.threshold });
  }
  const baselineSamples = baseline?.executions ?? 0;
  if (baseline === undefined || baselineSamples < rule.minSamples) {
    return hold(rule, 'insufficient_samples', { samples, baselineSamples, minSamples: rule.minSamples });
  }
  const baselineFailures = failureCount(baseline, rule.signal);
  return compareRates(rule, failures, samples, baselineFailures, baselineSamples, 'higher_is_worse');
}

function decideLatency(rule: GuardrailRule, canary: CohortTotals): GuardrailDecision {
  if (canary.latencySamples < rule.minSamples || canary.latencyP95Ms === null) {
    return hold(rule, 'insufficient_samples', {
      latencySamples: canary.latencySamples,
      minSamples: rule.minSamples,
      latencyP95Ms: canary.latencyP95Ms,
    });
  }
  if (canary.latencyP95Ms >= rule.threshold) {
    return stop(rule, {
      latencyP95Ms: canary.latencyP95Ms,
      threshold: rule.threshold,
      latencySamples: canary.latencySamples,
    });
  }
  return hold(rule, 'within_gate', { latencyP95Ms: canary.latencyP95Ms, threshold: rule.threshold });
}

function decideSpending(rule: GuardrailRule, canary: CohortTotals): GuardrailDecision {
  if (canary.costSamples < rule.minSamples) {
    return hold(rule, 'insufficient_samples', { costSamples: canary.costSamples, minSamples: rule.minSamples });
  }
  if (canary.costSum >= rule.threshold) {
    return stop(rule, { costSum: canary.costSum, threshold: rule.threshold, costSamples: canary.costSamples });
  }
  return hold(rule, 'within_gate', { costSum: canary.costSum, threshold: rule.threshold });
}

function decideQuality(
  rule: GuardrailRule,
  canary: CohortTotals,
  baseline: CohortTotals | undefined,
): GuardrailDecision {
  const counts = qualityCounts(canary, rule.signal);
  const gate = qualityGate(rule, counts);
  if (gate !== null) return gate;
  const mature = counts.mature;
  const failures = counts.failures;
  const successes = counts.successes;
  if (rule.kind === 'deterministic_quality') {
    const rate = failures / mature;
    if (rate >= rule.threshold) {
      return stop(rule, { rate, failures, successes, mature, missing: counts.missing, threshold: rule.threshold });
    }
    return hold(rule, 'within_gate', { rate, failures, successes, mature, threshold: rule.threshold });
  }
  const base = baseline === undefined ? undefined : qualityCounts(baseline, rule.signal);
  if (base === undefined) {
    return hold(rule, 'insufficient_samples', { mature, baselineMature: 0, minSamples: rule.minSamples });
  }
  const baseGate = qualityGate(rule, base);
  if (baseGate !== null) {
    return hold(rule, baseGate.reason, { ...baseGate.detail, baselineMature: base.mature });
  }
  return compareRates(rule, successes, mature, base.successes, base.mature, 'lower_is_worse');
}

function qualityGate(rule: GuardrailRule, counts: QualityCounts): GuardrailDecision | null {
  if (counts.immature > 0 && counts.mature < rule.minSamples) {
    return hold(rule, 'immature', {
      mature: counts.mature,
      immature: counts.immature,
      missing: counts.missing,
      minSamples: rule.minSamples,
    });
  }
  const considered = counts.mature + counts.missing;
  if (considered > 0 && counts.missing / considered > rule.maxMissingFraction) {
    return hold(rule, 'missing_feedback', {
      mature: counts.mature,
      missing: counts.missing,
      successes: counts.successes,
      maxMissingFraction: rule.maxMissingFraction,
    });
  }
  if (counts.mature > 0 && counts.unknown / counts.mature > rule.maxMissingFraction) {
    return hold(rule, 'inconclusive', {
      mature: counts.mature,
      unknown: counts.unknown,
      successes: counts.successes,
    });
  }
  if (counts.mature < rule.minSamples) {
    return hold(rule, 'insufficient_samples', {
      mature: counts.mature,
      missing: counts.missing,
      minSamples: rule.minSamples,
    });
  }
  return null;
}

function compareRates(
  rule: GuardrailRule,
  canaryEvents: number,
  canarySamples: number,
  baselineEvents: number,
  baselineSamples: number,
  direction: 'higher_is_worse' | 'lower_is_worse',
): GuardrailDecision {
  const canaryInterval = wilsonInterval(canaryEvents, canarySamples);
  const baselineInterval = wilsonInterval(baselineEvents, baselineSamples);
  if (canaryInterval === null || baselineInterval === null) {
    return hold(rule, 'inconclusive', { canarySamples, baselineSamples });
  }
  const separated =
    direction === 'higher_is_worse'
      ? canaryInterval.lower > baselineInterval.upper + rule.margin
      : canaryInterval.upper + rule.margin < baselineInterval.lower;
  const detail = {
    canaryLower: canaryInterval.lower,
    canaryUpper: canaryInterval.upper,
    baselineLower: baselineInterval.lower,
    baselineUpper: baselineInterval.upper,
    margin: rule.margin,
    canarySamples,
    baselineSamples,
  };
  if (separated) return stop(rule, detail);
  const overlaps =
    canaryInterval.lower <= baselineInterval.upper + rule.margin &&
    baselineInterval.lower <= canaryInterval.upper + rule.margin;
  return hold(rule, overlaps ? 'inconclusive' : 'within_gate', detail);
}

function qualityCounts(row: CohortTotals, signal: string): QualityCounts {
  if (signal === 'schema_valid') {
    return {
      successes: row.schemaPasses,
      failures: row.schemaFailures,
      unknown: row.schemaUnknown,
      mature: row.schemaMature,
      missing: row.schemaMissing,
      immature: row.schemaImmature,
    };
  }
  if (signal === 'correctness') {
    return {
      successes: row.correctnessSuccesses,
      failures: row.correctnessFailures,
      unknown: row.correctnessUnknown,
      mature: row.correctnessMature,
      missing: row.correctnessMissing,
      immature: row.correctnessImmature,
    };
  }
  if (signal === 'evaluation_quality') {
    const passes = row.evaluationPasses;
    const failures = row.evaluationFails;
    const unknown = row.evaluationUnknown;
    return {
      successes: passes,
      failures,
      unknown,
      mature: passes + failures + unknown,
      missing: 0,
      immature: 0,
    };
  }
  return {
    successes: row.taskSuccesses,
    failures: row.taskFailures,
    unknown: row.taskUnknown,
    mature: row.taskMature,
    missing: row.taskMissing,
    immature: row.taskImmature,
  };
}

function failureCount(row: CohortTotals, signal: string): number {
  if (signal === 'timeout_rate') return row.timeoutRequests;
  if (signal === 'incomplete_stream_rate') return row.incompleteStreamRequests;
  if (signal === 'retry_rate') return row.retryRequests;
  if (signal === 'fallback_rate') return row.fallbackRequests;
  return row.errorRequests;
}

function stop(rule: GuardrailRule, detail: Record<string, number | null>): GuardrailDecision {
  return {
    action: 'stop',
    ruleId: rule.id,
    kind: rule.kind,
    signal: rule.signal,
    reason: 'violation',
    detail: roundDetail(detail),
  };
}

function hold(
  rule: GuardrailRule,
  reason: DecisionReason,
  detail: Record<string, number | null>,
): GuardrailDecision {
  return {
    action: 'hold',
    ruleId: rule.id,
    kind: rule.kind,
    signal: rule.signal,
    reason,
    detail: roundDetail(detail),
  };
}

function roundDetail(detail: Record<string, number | null>): Record<string, number | null> {
  const rounded: Record<string, number | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    rounded[key] = value === null || Number.isInteger(value) ? value : Math.round(value * 1_000_000) / 1_000_000;
  }
  return rounded;
}
