import { createHash } from 'node:crypto';
import { invalidRequest } from './errors.js';
import { wilsonInterval, type WilsonInterval } from './evaluation-report.js';
import { inputSizeBand } from './sample-selection.js';
import { isTaskCategory } from './task-categories.js';

export const QUALIFICATION_STATUSES = ['qualified', 'unqualified', 'inconclusive', 'invalidated'] as const;
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

export const INPUT_SIZE_CATEGORIES = ['xs', 's', 'm', 'l', 'xl', 'xxl', 'unknown'] as const;
export type InputSizeCategory = (typeof INPUT_SIZE_CATEGORIES)[number];

export const CAPABILITIES = [
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

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RATE = /^(?:0|1)(?:\.0+)?$|^(?:0\.\d{1,5})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KNOWN_COST = new Set(['estimated', 'provisional', 'reconciled']);

export type ObjectiveResult = 'pass' | 'fail' | 'not_applicable' | 'unknown';

export type QualificationWrite = {
  name: string;
  taskCategory: string;
  complexity: 'low' | 'medium' | 'high';
  inputSizeCategory: InputSizeCategory;
  outputRequirementId: string;
  requiredCapabilities: readonly string[];
  candidateDeployment: string;
  modelVersion: string;
  deploymentConfigVersion: number;
  adapterVersion: number;
  minSamples: number;
  objectiveFloor: string;
  maxIntervalWidth: string;
  noninferiorityMargin: string;
  freshnessSeconds: number;
  minCoverage: string;
};

export type QualificationProfile = {
  taskCategory: string;
  complexity: 'low' | 'medium' | 'high';
  inputSizeCategory: InputSizeCategory;
  outputRequirementId: string;
  requiredCapabilities: readonly string[];
  candidateDeploymentName: string;
  modelVersion: string;
  deploymentConfigVersion: number;
  adapterVersion: number;
  minSamples: number;
  objectiveFloor: number;
  maxIntervalWidth: number;
  noninferiorityMargin: number;
  freshnessSeconds: number;
  minCoverage: number;
};

export type QualificationItem = {
  runId: string;
  runUpdatedAt: Date;
  runStatus: string;
  profileApproved: boolean;
  runTaskCategory: string;
  runProfileVersionId: string | null;
  sampleTaskCategory: string | null;
  complexity: string | null;
  inputSize: number | null;
  requiredCapabilities: string[] | null;
  challengerDeploymentName: string;
  challengerModel: string | null;
  configVersion: number | null;
  adapterVersion: number | null;
  attemptStatus: string | null;
  originalPresent: boolean;
  challengerLatencyMs: number | null;
  originalDurationMs: number | null;
  challengerCostAmount: string | null;
  challengerCostStatus: string | null;
  originalCostAmount: string | null;
  originalCostStatus: string | null;
  challengerResults: readonly ObjectiveResult[];
  originalResults: readonly ObjectiveResult[];
  judgeOutcome: string | null;
  forwardMapped: string | null;
  reverseMapped: string | null;
};

export type QualificationUncertainty = {
  method: 'wilson_95_newcombe';
  lower: number | null;
  upper: number | null;
  differenceLower: number | null;
};

export type QualificationDecision = {
  status: QualificationStatus;
  reasonCodes: string[];
  uncertainty: QualificationUncertainty;
  sampleCount: number;
  coverageRate: number;
  sourceRunIds: string[];
  challengerPasses: number;
  challengerTrials: number;
  originalPasses: number;
  originalTrials: number;
};

const EMPTY_UNCERTAINTY: QualificationUncertainty = {
  method: 'wilson_95_newcombe',
  lower: null,
  upper: null,
  differenceLower: null,
};

export function qualificationRequestHash(write: QualificationWrite): string {
  return createHash('sha256').update(canonicalWrite(write)).digest('hex');
}

export function refreshRequestHash(profileVersionId: string): string {
  return createHash('sha256').update(JSON.stringify({ profileVersionId })).digest('hex');
}

export function qualificationDigest(input: {
  taskCategory: string;
  complexity: string;
  inputSizeCategory: string;
  outputRequirementId: string;
  requiredCapabilities: readonly string[];
  candidateDeploymentId: string;
  modelVersion: string;
  deploymentConfigVersion: number;
  adapterVersion: number;
  minSamples: number;
  objectiveFloor: string;
  maxIntervalWidth: string;
  noninferiorityMargin: string;
  freshnessSeconds: number;
  minCoverage: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskCategory: input.taskCategory,
        complexity: input.complexity,
        inputSizeCategory: input.inputSizeCategory,
        outputRequirementId: input.outputRequirementId,
        requiredCapabilities: [...input.requiredCapabilities].sort(),
        candidateDeploymentId: input.candidateDeploymentId,
        modelVersion: input.modelVersion,
        deploymentConfigVersion: input.deploymentConfigVersion,
        adapterVersion: input.adapterVersion,
        minSamples: input.minSamples,
        objectiveFloor: input.objectiveFloor,
        maxIntervalWidth: input.maxIntervalWidth,
        noninferiorityMargin: input.noninferiorityMargin,
        freshnessSeconds: input.freshnessSeconds,
        minCoverage: input.minCoverage,
      }),
    )
    .digest('hex');
}

export function parseQualificationWrite(body: unknown): QualificationWrite {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The qualification body is invalid.');
  }
  const record = body as Record<string, unknown>;
  const allowed = new Set([
    'name',
    'taskCategory',
    'complexity',
    'inputSizeCategory',
    'outputRequirementId',
    'requiredCapabilities',
    'candidateDeployment',
    'modelVersion',
    'deploymentConfigVersion',
    'adapterVersion',
    'minSamples',
    'objectiveFloor',
    'maxIntervalWidth',
    'noninferiorityMargin',
    'freshnessSeconds',
    'minCoverage',
  ]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The qualification body is invalid.');
  }
  if (typeof record.name !== 'string' || !NAME.test(record.name) || record.name === 'auto') {
    throw invalidRequest('name', 'invalid_parameter', 'name is invalid.');
  }
  if (typeof record.taskCategory !== 'string' || !isTaskCategory(record.taskCategory)) {
    throw invalidRequest('taskCategory', 'invalid_parameter', 'taskCategory is invalid.');
  }
  if (record.complexity !== 'low' && record.complexity !== 'medium' && record.complexity !== 'high') {
    throw invalidRequest('complexity', 'invalid_parameter', 'complexity is invalid.');
  }
  if (typeof record.inputSizeCategory !== 'string' || !isInputSizeCategory(record.inputSizeCategory)) {
    throw invalidRequest('inputSizeCategory', 'invalid_parameter', 'inputSizeCategory is invalid.');
  }
  return {
    name: record.name,
    taskCategory: record.taskCategory,
    complexity: record.complexity,
    inputSizeCategory: record.inputSizeCategory,
    outputRequirementId: uuidField(record.outputRequirementId, 'outputRequirementId'),
    requiredCapabilities: capabilityList(record.requiredCapabilities),
    candidateDeployment: deploymentName(record.candidateDeployment),
    modelVersion: modelVersion(record.modelVersion),
    deploymentConfigVersion: integerField(record.deploymentConfigVersion, 'deploymentConfigVersion', 1, 1_000_000),
    adapterVersion: integerField(record.adapterVersion, 'adapterVersion', 1, 1_000_000),
    minSamples: integerField(record.minSamples, 'minSamples', 1, 10_000),
    objectiveFloor: rateField(record.objectiveFloor, 'objectiveFloor', true),
    maxIntervalWidth: rateField(record.maxIntervalWidth, 'maxIntervalWidth', false),
    noninferiorityMargin: rateField(record.noninferiorityMargin, 'noninferiorityMargin', false),
    freshnessSeconds: integerField(record.freshnessSeconds, 'freshnessSeconds', 1, 31_536_000),
    minCoverage: rateField(record.minCoverage, 'minCoverage', true),
  };
}

export function parseRefreshBody(body: unknown): string {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw invalidRequest('body', 'invalid_parameter', 'The qualification body is invalid.');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1) {
    throw invalidRequest('body', 'invalid_parameter', 'The qualification body is invalid.');
  }
  return uuidField(record.profileVersionId, 'profileVersionId');
}

export function parseEvidenceQuery(query: { profileVersionId?: string }): string | null {
  if (query.profileVersionId === undefined) return null;
  return uuidField(query.profileVersionId, 'profileVersionId');
}

export function qualifyCohort(
  profile: QualificationProfile,
  items: readonly QualificationItem[],
  now: Date,
): QualificationDecision {
  const counts = {
    expired: 0,
    wrongTask: 0,
    outputRequirement: 0,
    complexity: 0,
    size: 0,
    capability: 0,
    model: 0,
    adapter: 0,
    matched: 0,
    contradictory: 0,
    orderBias: 0,
    missingLatency: 0,
    unknownCost: 0,
    judgeInconclusive: 0,
    judgeUnstable: 0,
  };
  const runIds = new Set<string>();
  let challengerPasses = 0;
  let challengerFails = 0;
  let originalPasses = 0;
  let originalFails = 0;
  const freshnessMs = profile.freshnessSeconds * 1000;

  for (const item of items) {
    const bucket = classifyItem(profile, item, now, freshnessMs);
    if (bucket === 'skip') continue;
    runIds.add(item.runId);
    if (bucket === 'expired') counts.expired += 1;
    else if (bucket === 'wrong_task') counts.wrongTask += 1;
    else if (bucket === 'output_requirement') counts.outputRequirement += 1;
    else if (bucket === 'complexity') counts.complexity += 1;
    else if (bucket === 'size') counts.size += 1;
    else if (bucket === 'capability') counts.capability += 1;
    else if (bucket === 'model') counts.model += 1;
    else if (bucket === 'adapter') counts.adapter += 1;
    else {
      counts.matched += 1;
      const challenger = tally(item.challengerResults);
      const original = tally(item.originalResults);
      challengerPasses += challenger.pass;
      challengerFails += challenger.fail;
      originalPasses += original.pass;
      originalFails += original.fail;
      if (challenger.pass > 0 && challenger.fail > 0) counts.contradictory += 1;
      if (orderBias(item)) counts.orderBias += 1;
      else if (item.judgeOutcome === 'unstable') counts.judgeUnstable += 1;
      if (item.judgeOutcome === 'inconclusive') counts.judgeInconclusive += 1;
      if (item.challengerLatencyMs === null || item.originalDurationMs === null) counts.missingLatency += 1;
      if (!knownCost(item.challengerCostAmount, item.challengerCostStatus)) counts.unknownCost += 1;
      if (!knownCost(item.originalCostAmount, item.originalCostStatus)) counts.unknownCost += 1;
    }
  }

  const coverageDenom = counts.matched + counts.size + counts.complexity;
  const coverageRate = coverageDenom === 0 ? 0 : round6(counts.matched / coverageDenom);
  const sourceRunIds = [...runIds].sort();
  const base = {
    sampleCount: counts.matched,
    coverageRate,
    sourceRunIds,
    challengerPasses,
    challengerTrials: challengerPasses + challengerFails,
    originalPasses,
    originalTrials: originalPasses + originalFails,
  };

  if (counts.contradictory > 0) return decide('invalidated', ['contradictory_findings'], EMPTY_UNCERTAINTY, base);
  if (counts.orderBias > 0) return decide('invalidated', ['judge_order_bias'], EMPTY_UNCERTAINTY, base);
  if (counts.matched === 0) {
    const reason = firstMismatch(counts);
    if (reason === null) return decide('inconclusive', ['insufficient_samples'], EMPTY_UNCERTAINTY, base);
    return decide('invalidated', [reason], EMPTY_UNCERTAINTY, base);
  }
  if (counts.matched < profile.minSamples) {
    return decide('inconclusive', ['insufficient_samples'], EMPTY_UNCERTAINTY, base);
  }
  if (coverageRate < profile.minCoverage) {
    return decide('inconclusive', ['request_distribution_gap'], EMPTY_UNCERTAINTY, base);
  }
  if (counts.missingLatency > 0) return decide('inconclusive', ['missing_latency'], EMPTY_UNCERTAINTY, base);
  if (counts.unknownCost > 0) return decide('inconclusive', ['unknown_cost'], EMPTY_UNCERTAINTY, base);
  if (base.challengerTrials === 0 || base.originalTrials === 0) {
    return decide('inconclusive', ['judge_is_not_objective'], EMPTY_UNCERTAINTY, base);
  }

  const challenger = wilsonInterval(challengerPasses, base.challengerTrials);
  const original = wilsonInterval(originalPasses, base.originalTrials);
  if (challenger === null || original === null) {
    return decide('inconclusive', ['invalid_objective_result'], EMPTY_UNCERTAINTY, base);
  }
  const uncertainty = bounds(challenger, original);
  const width = round6(challenger.upper - challenger.lower);
  if (challenger.lower < profile.objectiveFloor) {
    return decide('unqualified', ['objective_threshold_failed'], uncertainty, base);
  }
  if (width > profile.maxIntervalWidth) {
    return decide('inconclusive', ['uncertainty_too_wide'], uncertainty, base);
  }
  if (uncertainty.differenceLower !== null && uncertainty.differenceLower <= -profile.noninferiorityMargin) {
    return decide('unqualified', ['noninferiority_failed'], uncertainty, base);
  }
  if (counts.judgeInconclusive > 0 || counts.judgeUnstable > 0) {
    return decide('inconclusive', ['judge_inconclusive'], uncertainty, base);
  }
  return decide('qualified', [], uncertainty, base);
}

function decide(
  status: QualificationStatus,
  reasonCodes: string[],
  uncertainty: QualificationUncertainty,
  base: Omit<QualificationDecision, 'status' | 'reasonCodes' | 'uncertainty'>,
): QualificationDecision {
  return { status, reasonCodes, uncertainty, ...base };
}

function classifyItem(
  profile: QualificationProfile,
  item: QualificationItem,
  now: Date,
  freshnessMs: number,
):
  | 'skip'
  | 'expired'
  | 'wrong_task'
  | 'output_requirement'
  | 'complexity'
  | 'size'
  | 'capability'
  | 'model'
  | 'adapter'
  | 'matched' {
  if (!item.profileApproved) return 'skip';
  if (item.runStatus !== 'completed' && item.runStatus !== 'completed_partial') return 'skip';
  if (item.attemptStatus !== 'completed' || !item.originalPresent) return 'skip';
  if (item.challengerDeploymentName !== profile.candidateDeploymentName) return 'skip';
  if (item.runUpdatedAt.getTime() < now.getTime() - freshnessMs) return 'expired';
  if (
    item.sampleTaskCategory === null ||
    item.sampleTaskCategory !== profile.taskCategory ||
    item.runTaskCategory !== profile.taskCategory
  ) {
    return 'wrong_task';
  }
  if (item.runProfileVersionId !== profile.outputRequirementId) return 'output_requirement';
  if (item.complexity !== profile.complexity) return 'complexity';
  if (item.inputSize === null || inputSizeBand(item.inputSize) !== profile.inputSizeCategory) return 'size';
  if (!capabilitiesMatch(profile.requiredCapabilities, item.requiredCapabilities)) return 'capability';
  if (
    item.challengerModel !== profile.modelVersion ||
    item.configVersion !== profile.deploymentConfigVersion
  ) {
    return 'model';
  }
  if (item.adapterVersion !== profile.adapterVersion) return 'adapter';
  return 'matched';
}

function capabilitiesMatch(required: readonly string[], sample: readonly string[] | null): boolean {
  if (sample === null) return false;
  return required.every((name) => sample.includes(name));
}

function tally(results: readonly ObjectiveResult[]): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  for (const result of results) {
    if (result === 'pass') pass += 1;
    else if (result === 'fail') fail += 1;
  }
  return { pass, fail };
}

function orderBias(item: QualificationItem): boolean {
  const forward = item.forwardMapped;
  const reverse = item.reverseMapped;
  if (forward === null || reverse === null || forward === reverse) return false;
  const winners = new Set([forward, reverse]);
  return winners.has('original') && winners.has('challenger');
}

function knownCost(amount: string | null, status: string | null): boolean {
  if (amount === null || status === null || !KNOWN_COST.has(status)) return false;
  return amount.length > 0;
}

function firstMismatch(counts: {
  expired: number;
  wrongTask: number;
  size: number;
  complexity: number;
  model: number;
  adapter: number;
  capability: number;
  outputRequirement: number;
}): string | null {
  if (counts.expired > 0) return 'expired_evidence';
  if (counts.wrongTask > 0) return 'wrong_task';
  if (counts.size > 0) return 'input_size_mismatch';
  if (counts.complexity > 0) return 'complexity_mismatch';
  if (counts.model > 0) return 'model_version_mismatch';
  if (counts.adapter > 0) return 'adapter_version_mismatch';
  if (counts.capability > 0) return 'capability_mismatch';
  if (counts.outputRequirement > 0) return 'output_requirement_mismatch';
  return null;
}

function bounds(challenger: WilsonInterval, original: WilsonInterval): QualificationUncertainty {
  const p1 = challenger.successes / challenger.trials;
  const p2 = original.successes / original.trials;
  const left = p1 - challenger.lower;
  const right = original.upper - p2;
  return {
    method: 'wilson_95_newcombe',
    lower: challenger.lower,
    upper: challenger.upper,
    differenceLower: round6(p1 - p2 - Math.sqrt(left * left + right * right)),
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function canonicalWrite(write: QualificationWrite): string {
  return JSON.stringify({
    name: write.name,
    taskCategory: write.taskCategory,
    complexity: write.complexity,
    inputSizeCategory: write.inputSizeCategory,
    outputRequirementId: write.outputRequirementId,
    requiredCapabilities: [...write.requiredCapabilities].sort(),
    candidateDeployment: write.candidateDeployment,
    modelVersion: write.modelVersion,
    deploymentConfigVersion: write.deploymentConfigVersion,
    adapterVersion: write.adapterVersion,
    minSamples: write.minSamples,
    objectiveFloor: write.objectiveFloor,
    maxIntervalWidth: write.maxIntervalWidth,
    noninferiorityMargin: write.noninferiorityMargin,
    freshnessSeconds: write.freshnessSeconds,
    minCoverage: write.minCoverage,
  });
}

function isInputSizeCategory(value: string): value is InputSizeCategory {
  return (INPUT_SIZE_CATEGORIES as readonly string[]).includes(value);
}

function uuidField(value: unknown, param: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value.toLowerCase();
}

function deploymentName(value: unknown): string {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'auto') {
    throw invalidRequest('candidateDeployment', 'invalid_parameter', 'candidateDeployment is invalid.');
  }
  return value;
}

function modelVersion(value: unknown): string {
  if (typeof value !== 'string' || !MODEL.test(value) || value === 'auto') {
    throw invalidRequest('modelVersion', 'invalid_parameter', 'modelVersion is invalid.');
  }
  return value;
}

function capabilityList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 12) {
    throw invalidRequest('requiredCapabilities', 'invalid_parameter', 'requiredCapabilities is invalid.');
  }
  const names: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !(CAPABILITIES as readonly string[]).includes(item)) {
      throw invalidRequest('requiredCapabilities', 'invalid_parameter', 'requiredCapabilities is invalid.');
    }
    names.push(item);
  }
  if (new Set(names).size !== names.length) {
    throw invalidRequest('requiredCapabilities', 'invalid_parameter', 'requiredCapabilities is invalid.');
  }
  return names;
}

function rateField(value: unknown, param: string, allowZero: boolean): string {
  if (typeof value !== 'string' || !RATE.test(value) || Number(value) > 1) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  const amount = Number(value);
  if (!allowZero && !(amount > 0)) throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  return amount.toFixed(5);
}

function integerField(value: unknown, param: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidRequest(param, 'invalid_parameter', `${param} is invalid.`);
  }
  return value;
}
