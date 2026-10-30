export const PROMOTION_GATES = [
  'unstable_judge',
  'qualified_evidence',
  'fresh_model_version',
  'fresh_config_version',
  'matched_samples',
  'quality_threshold',
  'noninferiority',
  'reliability_target',
  'latency_target',
  'cost_objective',
  'canary_window',
  'budget_policy',
  'provider_policy',
  'critical_incident',
] as const;

export type PromotionGate = (typeof PROMOTION_GATES)[number];

export const RELIABILITY_TARGET = 0.99;

const JUDGE_REASONS = new Set([
  'contradictory_findings',
  'judge_order_bias',
  'judge_is_not_objective',
  'judge_inconclusive',
  'invalid_objective_result',
]);

export type PromotionFacts = {
  evidenceStatus: string;
  reasonCodes: readonly string[];
  evidenceFresh: boolean;
  modelVersionMatches: boolean;
  configVersionMatches: boolean;
  matchedPairs: number;
  minMatchedPairs: number;
  wilsonLower: number | null;
  qualityMinPassRate: number;
  noninferiorityRequired: boolean;
  differenceLower: number | null;
  noninferiorityMargin: number;
  canarySamples: number;
  minCanarySamples: number;
  reliability: number | null;
  reliabilityTarget: number;
  latencyP95Ms: number | null;
  maxLatencyMs: number;
  canaryCost: number | null;
  baselineCost: number | null;
  maxCostPerRequest: number;
  budgetValid: boolean;
  providerValid: boolean;
  unresolvedCritical: boolean;
};

export type GateResult = { pass: true } | { pass: false; gate: PromotionGate };

export function evaluatePromotionGates(facts: PromotionFacts): GateResult {
  if (facts.reasonCodes.some((code) => JUDGE_REASONS.has(code))) return fail('unstable_judge');
  if (facts.evidenceStatus !== 'qualified' || !facts.evidenceFresh) return fail('qualified_evidence');
  if (!facts.modelVersionMatches) return fail('fresh_model_version');
  if (!facts.configVersionMatches) return fail('fresh_config_version');
  if (facts.matchedPairs < facts.minMatchedPairs) return fail('matched_samples');
  if (facts.wilsonLower === null || facts.wilsonLower < facts.qualityMinPassRate) return fail('quality_threshold');
  if (
    facts.noninferiorityRequired
    && (facts.differenceLower === null || facts.differenceLower + facts.noninferiorityMargin < 0)
  ) {
    return fail('noninferiority');
  }
  const observed = facts.canarySamples > 0;
  if (observed && (facts.reliability === null || facts.reliability < facts.reliabilityTarget)) {
    return fail('reliability_target');
  }
  if (observed && (facts.latencyP95Ms === null || facts.latencyP95Ms > facts.maxLatencyMs)) {
    return fail('latency_target');
  }
  if (observed && !costImproved(facts)) return fail('cost_objective');
  if (facts.canarySamples < facts.minCanarySamples) return fail('canary_window');
  if (!facts.budgetValid) return fail('budget_policy');
  if (!facts.providerValid) return fail('provider_policy');
  if (facts.unresolvedCritical) return fail('critical_incident');
  return { pass: true };
}

function costImproved(facts: PromotionFacts): boolean {
  if (facts.canaryCost === null || facts.baselineCost === null) return false;
  if (!(facts.canaryCost < facts.baselineCost)) return false;
  return facts.canaryCost <= facts.maxCostPerRequest;
}

function fail(gate: PromotionGate): GateResult {
  return { pass: false, gate };
}
