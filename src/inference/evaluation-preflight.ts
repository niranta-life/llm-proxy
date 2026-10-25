import { proxyError, type ProxyError } from './errors.js';

export const MAX_EVALUATION_ITEMS = 100;
export const MAX_OPEN_EVALUATION_RUNS = 100;

export const EVALUATION_CAPABILITIES = [
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'user',
  'response_format_text',
] as const;

export type PreflightCode =
  | 'sample_not_owned'
  | 'sample_expired'
  | 'sample_incomplete'
  | 'replay_denied'
  | 'judge_disclosure_denied'
  | 'deployment_unauthorized'
  | 'capability_mismatch'
  | 'residency_denied'
  | 'provider_denied'
  | 'budget_exceeded'
  | 'item_limit_exceeded'
  | 'run_limit_exceeded'
  | 'sample_category_mismatch';

export type PreflightSampleFact = {
  id: string;
  found: boolean;
  category: string | null;
  expiresFresh: boolean;
  exchangeComplete: boolean | null;
  requiredCapabilities: string[] | null;
  sourceLocation: string | null;
  contentBytes: number;
};

export type PreflightDeploymentFact = {
  name: string;
  enabled: boolean;
  connectionEnabled: boolean;
  provider: string;
  location: string | null;
  capabilities: string[];
};

export type PreflightPolicyFact = {
  replay: boolean;
  judgeDisclosure: boolean;
  allowedProviders: string[];
  allowedDeployments: string[];
};

export type PreflightFacts = {
  sampleCategory: string;
  sampleIds: readonly string[];
  samples: readonly PreflightSampleFact[];
  challenger: PreflightDeploymentFact | null;
  judge: PreflightDeploymentFact | null;
  judgeRequested: boolean;
  policy: PreflightPolicyFact | null;
  allowedRegions: readonly string[];
  requiredCapabilities: readonly string[] | null;
  budgetEstimate: string;
  budgetMode: 'observe' | 'hard' | 'disabled' | null;
  budgetLimit: string | null;
  openRuns: number;
  maxOpenRuns: number;
  maxItems: number;
  tenantItemCap: number | null;
};

const MESSAGES: Record<PreflightCode, string> = {
  sample_not_owned: 'The tenant does not own the sample.',
  sample_expired: 'The sample has expired.',
  sample_incomplete: 'The sample is not complete.',
  replay_denied: 'Replay permission is not granted.',
  judge_disclosure_denied: 'Judge disclosure permission is not granted.',
  deployment_unauthorized: 'The deployment is not approved.',
  capability_mismatch: 'The deployment does not meet the capability requirements.',
  residency_denied: 'The deployment does not meet the data residency rules.',
  provider_denied: 'The provider is not approved.',
  budget_exceeded: 'The budget estimate is above the configured limit.',
  item_limit_exceeded: 'The item count is above the service limit.',
  run_limit_exceeded: 'The run count is above the service limit.',
  sample_category_mismatch: 'The sample category does not match the evaluation.',
};

const PARAMS: Record<PreflightCode, string> = {
  sample_not_owned: 'sample_id',
  sample_expired: 'sample_id',
  sample_incomplete: 'sample_id',
  replay_denied: 'sample_id',
  judge_disclosure_denied: 'judge_deployment',
  deployment_unauthorized: 'challenger_deployment',
  capability_mismatch: 'challenger_deployment',
  residency_denied: 'challenger_deployment',
  provider_denied: 'challenger_deployment',
  budget_exceeded: 'budget_estimate',
  item_limit_exceeded: 'sample_ids',
  run_limit_exceeded: 'sample_ids',
  sample_category_mismatch: 'sample_category',
};

export function preflightRejection(code: PreflightCode, param?: string): ProxyError {
  return proxyError(400, 'invalid_request_error', code, param ?? PARAMS[code], MESSAGES[code]);
}

export function scaleDecimal(value: string): bigint | null {
  const match = /^(0|[1-9][0-9]{0,25})(?:\.([0-9]{1,12}))?$/.exec(value);
  if (match === null) return null;
  const whole = match[1];
  const fraction = match[2];
  if (whole === undefined) return null;
  const frac = (fraction ?? '').padEnd(12, '0');
  return BigInt(whole) * 1_000_000_000_000n + BigInt(frac);
}

export function preflightEvaluation(facts: PreflightFacts): void {
  if (facts.sampleIds.length > facts.maxItems) throw preflightRejection('item_limit_exceeded');
  if (facts.tenantItemCap !== null && facts.sampleIds.length > facts.tenantItemCap) {
    throw preflightRejection('item_limit_exceeded');
  }
  if (facts.openRuns >= facts.maxOpenRuns) throw preflightRejection('run_limit_exceeded');

  const byId = new Map(facts.samples.map((sample) => [sample.id, sample]));
  for (const sampleId of facts.sampleIds) {
    const sample = byId.get(sampleId);
    if (sample === undefined || !sample.found) throw preflightRejection('sample_not_owned');
    if (sample.category !== facts.sampleCategory) throw preflightRejection('sample_category_mismatch');
    if (!sample.expiresFresh) throw preflightRejection('sample_expired');
    if (sample.exchangeComplete !== true || sample.contentBytes <= 0) throw preflightRejection('sample_incomplete');
  }

  if (facts.policy === null || !facts.policy.replay) throw preflightRejection('replay_denied');
  assertDeployment(facts.challenger, facts.policy, 'challenger_deployment');
  assertResidency(facts);
  assertCapabilities(facts);

  if (facts.judgeRequested) {
    if (!facts.policy.judgeDisclosure) throw preflightRejection('judge_disclosure_denied');
    assertDeployment(facts.judge, facts.policy, 'judge_deployment');
  }

  if (facts.budgetMode === 'hard') {
    const estimate = scaleDecimal(facts.budgetEstimate);
    const limit = facts.budgetLimit === null ? null : scaleDecimal(facts.budgetLimit);
    if (estimate === null || limit === null || estimate > limit) throw preflightRejection('budget_exceeded');
  }
}

function assertDeployment(
  target: PreflightDeploymentFact | null,
  policy: PreflightPolicyFact,
  param: 'challenger_deployment' | 'judge_deployment',
): asserts target is PreflightDeploymentFact {
  if (
    target === null ||
    !target.enabled ||
    !target.connectionEnabled ||
    !policy.allowedDeployments.includes(target.name)
  ) {
    throw preflightRejection('deployment_unauthorized', param);
  }
  if (!policy.allowedProviders.includes(target.provider)) throw preflightRejection('provider_denied', param);
}

function assertResidency(facts: PreflightFacts): void {
  const target = facts.challenger;
  if (target === null) throw preflightRejection('residency_denied');
  if (facts.allowedRegions.length > 0 && (target.location === null || !facts.allowedRegions.includes(target.location))) {
    throw preflightRejection('residency_denied');
  }
  for (const sampleId of facts.sampleIds) {
    const sample = facts.samples.find((item) => item.id === sampleId);
    const source = sample?.sourceLocation ?? null;
    if (source !== null && target.location === null) throw preflightRejection('residency_denied');
    if (source !== null && target.location !== null && source !== target.location) {
      throw preflightRejection('residency_denied');
    }
  }
}

function assertCapabilities(facts: PreflightFacts): void {
  const target = facts.challenger;
  if (target === null) throw preflightRejection('capability_mismatch');
  let required: string[];
  if (facts.requiredCapabilities !== null) {
    required = [...facts.requiredCapabilities];
  } else {
    required = [];
    for (const sampleId of facts.sampleIds) {
      const sample = facts.samples.find((item) => item.id === sampleId);
      if (sample === undefined || sample.requiredCapabilities === null) throw preflightRejection('capability_mismatch');
      required.push(...sample.requiredCapabilities);
    }
  }
  const unique = [...new Set(required)];
  if (!unique.every((name) => target.capabilities.includes(name))) throw preflightRejection('capability_mismatch');
}
