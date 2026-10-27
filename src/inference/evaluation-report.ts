import type { PoolClient } from 'pg';
import { invalidRequest } from './errors.js';
import { parseEvaluationListQuery } from './evaluations.js';
import { addMoney } from './judge.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';

export const REPORT_MIN_VALID_PAIRS = 20;

const Z = 1.96;

export const QUALITY_GATES: Record<TaskCategory, number> = {
  classification: 0.9,
  extraction: 0.9,
  summarization: 0.8,
  reasoning: 0.8,
  coding: 0.85,
  translation: 0.85,
  writing: 0.8,
  general_qa: 0.8,
  unknown: 0.95,
};

const FINISHED = new Set(['completed', 'completed_partial']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RecommendationState =
  | 'promising'
  | 'eligible_for_canary'
  | 'retain_current'
  | 'inconclusive'
  | 'blocked';

export type IntervalDirection =
  | 'favors_challenger'
  | 'favors_original'
  | 'not_significant'
  | 'insufficient'
  | 'conflicting';

export type WilsonInterval = { lower: number; upper: number; successes: number; trials: number };

type Gate = 'pass' | 'fail' | 'not_applicable';
type CostWord = 'estimated' | 'provisional' | 'reconciled' | 'unknown' | 'missing';
type Outcome = 'model_a' | 'model_b' | 'tie' | 'inconclusive' | 'unstable';
type Candidate = 'original' | 'challenger';
type ObjectiveResult = 'pass' | 'fail' | 'not_applicable' | 'unknown';

export type ReportEvidence = {
  runId: string;
  status: string;
  sampleCategory: string;
  profileVersionId: string | null;
  profileName: string | null;
  profileVersion: number | null;
  rubricVersionId: string | null;
  rubricName: string | null;
  rubricVersion: number | null;
  items: ReportItem[];
};

export type ReportItem = {
  itemId: string;
  sampleId: string;
  itemStatus: string;
  itemReason: string | null;
  sampleTaskCategory: string | null;
  attempt: null | {
    id: string;
    status: string;
    reasonCode: string | null;
    originalDeployment: string;
    challengerDeployment: string;
    configVersion: number;
    adapterVersion: number;
    latencyMs: number | null;
    costAmount: string | null;
    costStatus: string | null;
    challengerModel: string | null;
  };
  original: null | {
    id: string;
    upstreamModel: string;
    durationMs: number | null;
    costAmount: string | null;
    costStatus: string | null;
  };
  validators: Array<{
    id: string;
    profileVersionId: string;
    candidate: Candidate;
    result: ObjectiveResult;
  }>;
  finding: null | {
    id: string;
    rubricVersionId: string;
    judgeModel: string;
    outcome: Outcome;
    costAmount: string | null;
    costStatus: string | null;
  };
};

type SideCount = {
  pass: number;
  fail: number;
  notApplicable: number;
  unknown: number;
  rate: number | null;
};

type CostSide = {
  total: string | null;
  status: CostWord;
  count: number;
  missing: number;
};

type AttemptCost = { attemptId: string; amount: string | null; status: string | null };

type LatencySeries = {
  medianMs: number | null;
  p95Ms: number | null;
  count: number;
  series: 'evaluation' | 'production';
  comparableToEvaluation: boolean;
};

export type EvaluationRecommendation = {
  evaluationId: string;
  state: RecommendationState;
  readOnly: true;
  routingChange: false;
  evidenceIds: {
    runId: string;
    profileVersionId: string | null;
    rubricVersionId: string | null;
    itemIds: string[];
    excludedItemIds: string[];
    attemptIds: string[];
    originalAttemptIds: string[];
    validatorResultIds: string[];
    findingIds: string[];
  };
  profileVersion: { id: string; name: string | null; version: number | null } | null;
  rubricVersion: { id: string; name: string | null; version: number | null } | null;
  sampleCount: number;
  totalSamples: number;
  exclusionCount: number;
  qualityCriteria: {
    minimumValidPairs: number;
    taskCategory: string;
    objectivePassRateFloor: number;
    gate: Gate;
  };
  uncertainty: {
    method: 'wilson_95';
    equivalentQuality: false;
    direction: IntervalDirection;
    judge: (WilsonInterval & { direction: IntervalDirection }) | null;
    objective: {
      original: WilsonInterval | null;
      challenger: WilsonInterval | null;
      direction: IntervalDirection;
    } | null;
  };
  cost: {
    original: CostSide;
    challenger: CostSide;
    judge: CostSide;
    evaluationExpense: { amount: string | null; status: CostWord };
  };
  latency: {
    evaluation: LatencySeries;
    historical: LatencySeries;
    note: 'historical_latency_is_a_separate_series';
  };
  reliability: { attempted: number; completed: number; rate: number | null };
  reasonCodes: string[];
  limitations: string[];
  modelVersions: {
    originalDeployments: string[];
    challengerDeployments: string[];
    originalModels: string[];
    challengerModels: string[];
    judgeModels: string[];
    configVersions: number[];
    adapterVersions: number[];
  };
  generatedAt: string;
};

export type EvaluationReport = {
  evaluationId: string;
  status: string;
  readOnly: true;
  routingChange: false;
  generatedAt: string;
  samples: {
    total: number;
    validPairs: number;
    excluded: number;
    exclusionReasons: Record<string, number>;
  };
  quality: {
    comparable: boolean;
    incomparableReasons: string[];
    objective: { original: SideCount; challenger: SideCount };
    judge: {
      originalWins: number;
      challengerWins: number;
      ties: number;
      unstable: number;
      inconclusive: number;
    };
  };
  cost: EvaluationRecommendation['cost'] & {
    challengerAttempts: AttemptCost[];
    originalAttempts: AttemptCost[];
    judgeFindings: AttemptCost[];
  };
  latency: EvaluationRecommendation['latency'];
  reliability: EvaluationRecommendation['reliability'];
  models: EvaluationRecommendation['modelVersions'];
  recommendation: EvaluationRecommendation;
};

export function wilsonInterval(successes: number, trials: number): WilsonInterval | null {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials < 1 || successes < 0 || successes > trials) {
    return null;
  }
  const z2 = Z * Z;
  const n = trials;
  const p = successes / n;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: round6(Math.max(0, center - margin)),
    upper: round6(Math.min(1, center + margin)),
    successes,
    trials,
  };
}

export function buildEvaluationReport(evidence: ReportEvidence, generatedAt: string): EvaluationReport {
  const category = isTaskCategory(evidence.sampleCategory) ? evidence.sampleCategory : 'unknown';
  const floor = QUALITY_GATES[category];
  const valid = evidence.items.filter((item) => item.attempt?.status === 'completed');
  const excluded = evidence.items.filter((item) => item.attempt?.status !== 'completed');
  const exclusionReasons = countCodes(excluded.map(exclusionReason));
  const incomparable = incomparableReasons(evidence, valid);
  const comparable = incomparable.length === 0;
  const objective = {
    original: sideCount(valid, 'original', comparable),
    challenger: sideCount(valid, 'challenger', comparable),
  };
  const judge = judgeCounts(valid);
  const challengerCosts = valid.map((item) => ({
    attemptId: item.attempt?.id ?? '',
    amount: item.attempt?.costAmount ?? null,
    status: item.attempt?.costStatus ?? null,
  }));
  const originalCosts = valid.map((item) => ({
    attemptId: item.original?.id ?? '',
    amount: item.original?.costAmount ?? null,
    status: item.original?.costStatus ?? null,
  }));
  const judgeCosts = valid
    .filter((item) => item.finding !== null)
    .map((item) => ({
      attemptId: item.finding?.id ?? '',
      amount: item.finding?.costAmount ?? null,
      status: item.finding?.costStatus ?? null,
    }));
  const executed = evidence.items.filter((item) => item.attempt !== null && item.attempt.status !== 'reserved');
  const executedCosts = executed.map((item) => ({
    amount: item.attempt?.costAmount ?? null,
    status: item.attempt?.costStatus ?? null,
  }));
  const expenseRows = [...executedCosts, ...judgeCosts.map((row) => ({ amount: row.amount, status: row.status }))];
  const cost = {
    original: rollup(originalCosts),
    challenger: rollup(challengerCosts),
    judge: rollup(judgeCosts),
    evaluationExpense: expense(expenseRows),
    challengerAttempts: challengerCosts,
    originalAttempts: originalCosts,
    judgeFindings: judgeCosts,
  };
  const evaluationLatency = latencySeries(
    valid.map((item) => item.attempt?.latencyMs ?? null),
    'evaluation',
    true,
  );
  const historicalLatency = latencySeries(
    valid.map((item) => item.original?.durationMs ?? null),
    'production',
    false,
  );
  const attempted = evidence.items.filter((item) => item.attempt !== null).length;
  const reliability = {
    attempted,
    completed: valid.length,
    rate: attempted === 0 ? null : round6(valid.length / attempted),
  };
  const models = modelVersions(valid);
  const gate = qualityGate(comparable, objective.challenger, floor);
  const judgeInterval = wilsonInterval(judge.challengerWins, judge.originalWins + judge.challengerWins);
  const judgeDirection = proportionDirection(judgeInterval);
  const objectiveUncertainty = objectiveUncertaintyFor(valid, comparable);
  const direction = combineDirections(judgeDirection, objectiveUncertainty?.direction ?? 'insufficient');
  const decision = decide({
    finished: FINISHED.has(evidence.status),
    incomparable,
    validPairs: valid.length,
    hasObjective: objective.original.pass + objective.original.fail + objective.challenger.pass + objective.challenger.fail > 0,
    findings: valid.filter((item) => item.finding !== null).length,
    inconclusive: judge.inconclusive,
    unstable: judge.unstable,
    ties: judge.ties,
    gate,
    direction,
  });
  const limitations = ['historical_latency_is_a_separate_series'];
  if (!comparable) limitations.push('quality_not_pooled');
  if (direction === 'not_significant' || direction === 'insufficient' || decision.reasons.includes('tie')) {
    limitations.push('difference_is_not_equal_quality');
  }
  const recommendation: EvaluationRecommendation = {
    evaluationId: evidence.runId,
    state: decision.state,
    readOnly: true,
    routingChange: false,
    evidenceIds: {
      runId: evidence.runId,
      profileVersionId: evidence.profileVersionId,
      rubricVersionId: evidence.rubricVersionId,
      itemIds: ids(valid.map((item) => item.itemId)),
      excludedItemIds: ids(excluded.map((item) => item.itemId)),
      attemptIds: ids(valid.map((item) => item.attempt?.id ?? '')),
      originalAttemptIds: ids(valid.map((item) => item.original?.id ?? '')),
      validatorResultIds: ids(valid.flatMap((item) => item.validators.map((row) => row.id))),
      findingIds: ids(valid.map((item) => item.finding?.id ?? '')),
    },
    profileVersion:
      evidence.profileVersionId === null
        ? null
        : { id: evidence.profileVersionId, name: evidence.profileName, version: evidence.profileVersion },
    rubricVersion:
      evidence.rubricVersionId === null
        ? null
        : { id: evidence.rubricVersionId, name: evidence.rubricName, version: evidence.rubricVersion },
    sampleCount: valid.length,
    totalSamples: evidence.items.length,
    exclusionCount: excluded.length,
    qualityCriteria: {
      minimumValidPairs: REPORT_MIN_VALID_PAIRS,
      taskCategory: category,
      objectivePassRateFloor: floor,
      gate,
    },
    uncertainty: {
      method: 'wilson_95',
      equivalentQuality: false,
      direction,
      judge: judgeInterval === null ? null : { ...judgeInterval, direction: judgeDirection },
      objective: objectiveUncertainty,
    },
    cost: {
      original: cost.original,
      challenger: cost.challenger,
      judge: cost.judge,
      evaluationExpense: cost.evaluationExpense,
    },
    latency: {
      evaluation: evaluationLatency,
      historical: historicalLatency,
      note: 'historical_latency_is_a_separate_series',
    },
    reliability,
    reasonCodes: decision.reasons,
    limitations,
    modelVersions: models,
    generatedAt,
  };
  return {
    evaluationId: evidence.runId,
    status: evidence.status,
    readOnly: true,
    routingChange: false,
    generatedAt,
    samples: {
      total: evidence.items.length,
      validPairs: valid.length,
      excluded: excluded.length,
      exclusionReasons,
    },
    quality: { comparable, incomparableReasons: incomparable, objective, judge },
    cost,
    latency: recommendation.latency,
    reliability,
    models,
    recommendation,
  };
}

export function parseRecommendationQuery(query: { limit?: string; cursor?: string; tenantId?: string }): {
  limit: number;
  cursor: string | null;
  tenantId: string | null;
} {
  const page = parseEvaluationListQuery(query);
  if (query.tenantId === undefined) return { ...page, tenantId: null };
  if (!UUID.test(query.tenantId)) throw invalidRequest('tenant_id', 'invalid_parameter', 'tenantId is invalid.');
  return { ...page, tenantId: query.tenantId.toLowerCase() };
}

export async function readEvaluationReport(
  client: PoolClient,
  evaluationId: string,
  generatedAt: string,
): Promise<EvaluationReport | null> {
  const evidence = await loadEvidence(client, evaluationId);
  if (evidence === null) return null;
  return buildEvaluationReport(evidence, generatedAt);
}

export async function listEvaluationRecommendations(
  client: PoolClient,
  query: { limit: number; cursor: string | null },
  generatedAt: string,
): Promise<{ recommendations: EvaluationRecommendation[]; nextCursor: string | null }> {
  if (query.cursor !== null) {
    const found = await client.query(`SELECT 1 FROM evaluation_runs WHERE id = $1`, [query.cursor]);
    if ((found.rowCount ?? 0) === 0) throw invalidRequest('cursor', 'invalid_parameter', 'cursor is invalid.');
  }
  const result = await client.query<{ id: string }>(
    `SELECT r.id::text AS id
     FROM evaluation_runs r
     WHERE r.status IN ('completed', 'completed_partial')
       AND (
         $1::uuid IS NULL
         OR (r.created_at, r.id) < (SELECT c.created_at, c.id FROM evaluation_runs c WHERE c.id = $1)
       )
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT $2`,
    [query.cursor, query.limit + 1],
  );
  const page = result.rows.slice(0, query.limit);
  const recommendations: EvaluationRecommendation[] = [];
  for (const row of page) {
    const report = await readEvaluationReport(client, row.id, generatedAt);
    if (report !== null) recommendations.push(report.recommendation);
  }
  const last = page.at(-1);
  const nextCursor = result.rows.length > query.limit && last !== undefined ? last.id : null;
  return { recommendations, nextCursor };
}

function decide(input: {
  finished: boolean;
  incomparable: string[];
  validPairs: number;
  hasObjective: boolean;
  findings: number;
  inconclusive: number;
  unstable: number;
  ties: number;
  gate: Gate;
  direction: IntervalDirection;
}): { state: RecommendationState; reasons: string[] } {
  if (!input.finished) return { state: 'inconclusive', reasons: ['run_not_completed'] };
  if (input.incomparable.length > 0) return { state: 'inconclusive', reasons: input.incomparable };
  if (input.validPairs === 0) return { state: 'inconclusive', reasons: ['zero_valid_pairs'] };
  if (!input.hasObjective && input.findings === 0) return { state: 'inconclusive', reasons: ['missing_quality'] };
  if (!input.hasObjective && input.findings > 0 && input.inconclusive === input.findings) {
    return { state: 'inconclusive', reasons: ['all_inconclusive'] };
  }
  if (!input.hasObjective && input.findings > 0 && input.unstable === input.findings) {
    return { state: 'inconclusive', reasons: ['judge_disagreement'] };
  }
  if (input.gate === 'fail') return { state: 'blocked', reasons: ['quality_gate_failed'] };
  if (input.direction === 'favors_original') return { state: 'retain_current', reasons: ['favors_original'] };
  if (input.direction === 'favors_challenger') {
    if (input.gate !== 'pass') return { state: 'inconclusive', reasons: ['quality_gate_not_applicable'] };
    const reasons = ['interval_favors_challenger', 'quality_gate_passed'];
    if (input.validPairs >= REPORT_MIN_VALID_PAIRS) return { state: 'eligible_for_canary', reasons };
    return { state: 'promising', reasons: [...reasons, 'below_minimum_sample'] };
  }
  if (input.direction === 'conflicting') return { state: 'inconclusive', reasons: ['conflicting_signals'] };
  const reasons = ['difference_not_significant', 'not_equivalent_quality'];
  if (input.findings > 0 && input.ties === input.findings) reasons.unshift('tie');
  return { state: 'inconclusive', reasons };
}

function incomparableReasons(evidence: ReportEvidence, valid: ReportItem[]): string[] {
  const reasons: string[] = [];
  const tasks = new Set(valid.map((item) => item.sampleTaskCategory));
  if ([...tasks].some((task) => task !== evidence.sampleCategory)) reasons.push('mixed_task_category');
  const validatorProfiles = new Set(valid.flatMap((item) => item.validators.map((row) => row.profileVersionId)));
  if (validatorProfiles.size > 1) reasons.push('mixed_profile');
  else if (
    evidence.profileVersionId !== null &&
    validatorProfiles.size === 1 &&
    !validatorProfiles.has(evidence.profileVersionId)
  ) {
    reasons.push('mixed_profile');
  }
  const rubrics = new Set(valid.flatMap((item) => (item.finding === null ? [] : [item.finding.rubricVersionId])));
  if (rubrics.size > 1) reasons.push('mixed_rubric_version');
  else if (evidence.rubricVersionId !== null && rubrics.size === 1 && !rubrics.has(evidence.rubricVersionId)) {
    reasons.push('mixed_rubric_version');
  }
  const configs = new Set(
    valid.map((item) =>
      item.attempt === null
        ? ''
        : [
            item.attempt.challengerDeployment,
            item.attempt.configVersion,
            item.attempt.adapterVersion,
            item.attempt.challengerModel ?? '',
          ].join('\n'),
    ),
  );
  if (configs.size > 1) reasons.push('mixed_model_configuration');
  return reasons;
}

function qualityGate(comparable: boolean, challenger: SideCount, floor: number): Gate {
  if (!comparable) return 'not_applicable';
  const denom = challenger.pass + challenger.fail;
  if (denom === 0) return 'not_applicable';
  return challenger.pass / denom < floor ? 'fail' : 'pass';
}

function sideCount(items: ReportItem[], candidate: Candidate, comparable: boolean): SideCount {
  const counts = { pass: 0, fail: 0, notApplicable: 0, unknown: 0 };
  for (const item of items) {
    for (const row of item.validators) {
      if (row.candidate !== candidate) continue;
      if (row.result === 'pass') counts.pass += 1;
      else if (row.result === 'fail') counts.fail += 1;
      else if (row.result === 'not_applicable') counts.notApplicable += 1;
      else counts.unknown += 1;
    }
  }
  const denom = counts.pass + counts.fail;
  return { ...counts, rate: !comparable || denom === 0 ? null : round6(counts.pass / denom) };
}

function judgeCounts(items: ReportItem[]): EvaluationReport['quality']['judge'] {
  const counts = { originalWins: 0, challengerWins: 0, ties: 0, unstable: 0, inconclusive: 0 };
  for (const item of items) {
    const outcome = item.finding?.outcome;
    if (outcome === 'model_a') counts.originalWins += 1;
    else if (outcome === 'model_b') counts.challengerWins += 1;
    else if (outcome === 'tie') counts.ties += 1;
    else if (outcome === 'unstable') counts.unstable += 1;
    else if (outcome === 'inconclusive') counts.inconclusive += 1;
  }
  return counts;
}

function objectiveUncertaintyFor(
  items: ReportItem[],
  comparable: boolean,
): { original: WilsonInterval | null; challenger: WilsonInterval | null; direction: IntervalDirection } | null {
  if (!comparable) return null;
  const original = tally(items, 'original');
  const challenger = tally(items, 'challenger');
  const originalInterval = wilsonInterval(original.pass, original.pass + original.fail);
  const challengerInterval = wilsonInterval(challenger.pass, challenger.pass + challenger.fail);
  return {
    original: originalInterval,
    challenger: challengerInterval,
    direction: intervalSeparation(challengerInterval, originalInterval),
  };
}

function tally(items: ReportItem[], candidate: Candidate): { pass: number; fail: number } {
  let pass = 0;
  let fail = 0;
  for (const item of items) {
    for (const row of item.validators) {
      if (row.candidate !== candidate) continue;
      if (row.result === 'pass') pass += 1;
      else if (row.result === 'fail') fail += 1;
    }
  }
  return { pass, fail };
}

function proportionDirection(interval: WilsonInterval | null): IntervalDirection {
  if (interval === null) return 'insufficient';
  if (interval.lower > 0.5) return 'favors_challenger';
  if (interval.upper < 0.5) return 'favors_original';
  return 'not_significant';
}

function intervalSeparation(challenger: WilsonInterval | null, original: WilsonInterval | null): IntervalDirection {
  if (challenger === null || original === null) return 'insufficient';
  if (challenger.lower > original.upper) return 'favors_challenger';
  if (challenger.upper < original.lower) return 'favors_original';
  return 'not_significant';
}

function combineDirections(judge: IntervalDirection, objective: IntervalDirection): IntervalDirection {
  const known = [judge, objective].filter((direction) => direction === 'favors_challenger' || direction === 'favors_original');
  const favorsChallenger = known.includes('favors_challenger');
  const favorsOriginal = known.includes('favors_original');
  if (favorsChallenger && favorsOriginal) return 'conflicting';
  if (favorsChallenger) return 'favors_challenger';
  if (favorsOriginal) return 'favors_original';
  if (judge === 'not_significant' || objective === 'not_significant') return 'not_significant';
  return 'insufficient';
}

function exclusionReason(item: ReportItem): string {
  if (item.attempt !== null && item.attempt.status !== 'completed') {
    return item.attempt.reasonCode ?? item.attempt.status;
  }
  return item.itemReason ?? item.itemStatus;
}

function countCodes(codes: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const code of [...codes].sort()) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

function rollup(rows: AttemptCost[]): CostSide {
  const summed = expense(rows);
  return {
    total: summed.amount,
    status: summed.status,
    count: rows.length,
    missing: rows.filter((row) => row.amount === null).length,
  };
}

function expense(rows: Array<{ amount: string | null; status: string | null }>): { amount: string | null; status: CostWord } {
  if (rows.length === 0) return { amount: null, status: 'missing' };
  if (rows.some((row) => row.amount === null)) return { amount: null, status: 'missing' };
  let total: string | null = null;
  const statuses = new Set<string>();
  for (const row of rows) {
    if (row.amount === null) continue;
    total = total === null ? row.amount : addMoney(total, row.amount);
    statuses.add(row.status ?? 'unknown');
  }
  if (total === null) return { amount: null, status: 'missing' };
  return { amount: total, status: costWord(statuses) };
}

function costWord(statuses: Set<string>): CostWord {
  if (statuses.has('provisional')) return 'provisional';
  if (statuses.has('unknown')) return 'unknown';
  if (statuses.has('estimated')) return 'estimated';
  return 'reconciled';
}

function latencySeries(
  values: Array<number | null>,
  series: 'evaluation' | 'production',
  comparableToEvaluation: boolean,
): LatencySeries {
  const present = values.filter((value): value is number => value !== null);
  return {
    medianMs: median(present),
    p95Ms: percentile(present, 0.95),
    count: present.length,
    series,
    comparableToEvaluation,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const left = sorted[mid - 1];
  const right = sorted[mid];
  if (left === undefined || right === undefined) return null;
  return (left + right) / 2;
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

function modelVersions(items: ReportItem[]): EvaluationRecommendation['modelVersions'] {
  return {
    originalDeployments: uniqueText(items.map((item) => item.attempt?.originalDeployment ?? null)),
    challengerDeployments: uniqueText(items.map((item) => item.attempt?.challengerDeployment ?? null)),
    originalModels: uniqueText(items.map((item) => item.original?.upstreamModel ?? null)),
    challengerModels: uniqueText(items.map((item) => item.attempt?.challengerModel ?? null)),
    judgeModels: uniqueText(items.map((item) => item.finding?.judgeModel ?? null)),
    configVersions: uniqueNumber(items.map((item) => item.attempt?.configVersion ?? null)),
    adapterVersions: uniqueNumber(items.map((item) => item.attempt?.adapterVersion ?? null)),
  };
}

function uniqueText(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null && value.length > 0))].sort();
}

function uniqueNumber(values: Array<number | null>): number[] {
  return [...new Set(values.filter((value): value is number => value !== null))].sort((left, right) => left - right);
}

function ids(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))].sort();
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

type ItemRow = {
  run_id: string;
  status: string;
  sample_category: string;
  profile_version_id: string | null;
  profile_name: string | null;
  profile_version: number | null;
  rubric_version_id: string | null;
  rubric_name: string | null;
  rubric_version: number | null;
  item_id: string;
  sample_id: string;
  item_status: string;
  item_reason: string | null;
  sample_task_category: string | null;
  attempt_id: string | null;
  attempt_status: string | null;
  attempt_reason: string | null;
  original_deployment: string | null;
  challenger_deployment: string | null;
  config_version: number | null;
  adapter_version: number | null;
  latency_ms: number | null;
  cost_amount: string | null;
  cost_status: string | null;
  challenger_model: string | null;
  original_attempt_id: string | null;
  original_model: string | null;
  original_duration_ms: number | null;
  original_cost_amount: string | null;
  original_cost_status: string | null;
};

async function loadEvidence(client: PoolClient, evaluationId: string): Promise<ReportEvidence | null> {
  const rows = await client.query<ItemRow>(
    `SELECT r.id::text AS run_id,
            r.status,
            r.sample_category,
            r.profile_version_id::text AS profile_version_id,
            p.name AS profile_name,
            pv.version AS profile_version,
            r.rubric_version_id::text AS rubric_version_id,
            rb.name AS rubric_name,
            rv.version AS rubric_version,
            i.id::text AS item_id,
            i.sample_id::text AS sample_id,
            i.status AS item_status,
            i.reason_code AS item_reason,
            s.task_category AS sample_task_category,
            a.id::text AS attempt_id,
            a.status AS attempt_status,
            a.reason_code AS attempt_reason,
            a.original_deployment,
            a.challenger_deployment,
            a.config_version,
            a.adapter_version,
            a.latency_ms,
            a.cost_amount::text AS cost_amount,
            a.cost_status,
            cma.upstream_model AS challenger_model,
            oma.id::text AS original_attempt_id,
            oma.upstream_model AS original_model,
            oma.duration_ms AS original_duration_ms,
            oc.amount::text AS original_cost_amount,
            oc.cost_status AS original_cost_status
     FROM evaluation_runs r
     JOIN evaluation_items i ON i.tenant_id = r.tenant_id AND i.run_id = r.id
     LEFT JOIN evaluation_profile_versions pv ON pv.id = r.profile_version_id
     LEFT JOIN evaluation_profiles p ON p.tenant_id = pv.tenant_id AND p.id = pv.profile_id
     LEFT JOIN evaluation_rubric_versions rv ON rv.id = r.rubric_version_id
     LEFT JOIN evaluation_rubrics rb ON rb.tenant_id = rv.tenant_id AND rb.id = rv.rubric_id
     LEFT JOIN request_samples s ON s.tenant_id = i.tenant_id AND s.id = i.sample_id
     LEFT JOIN evaluation_attempts a ON a.tenant_id = i.tenant_id AND a.item_id = i.id
     LEFT JOIN model_attempts cma ON cma.tenant_id = a.tenant_id AND cma.id = a.model_attempt_id
     LEFT JOIN LATERAL (
       SELECT ma.id, ma.upstream_model, ma.duration_ms
       FROM model_attempts ma
       WHERE ma.tenant_id = s.tenant_id AND ma.request_id = s.request_id
       ORDER BY (ma.status = 'succeeded') DESC, ma.created_at DESC
       LIMIT 1
     ) oma ON true
     LEFT JOIN attempt_costs oc ON oc.tenant_id = s.tenant_id AND oc.attempt_id = oma.id
     WHERE r.id = $1
     ORDER BY i.ordinal`,
    [evaluationId],
  );
  const first = rows.rows[0];
  if (first === undefined) return null;
  const validators = await client.query<{
    id: string;
    item_id: string;
    profile_version_id: string;
    candidate: string;
    result: string;
  }>(
    `SELECT id::text AS id, item_id::text AS item_id, profile_version_id::text AS profile_version_id, candidate, result
     FROM evaluation_validator_results
     WHERE run_id = $1`,
    [evaluationId],
  );
  const findings = await client.query<{
    id: string;
    item_id: string;
    rubric_version_id: string;
    judge_model: string;
    outcome: string;
    cost_amount: string | null;
    cost_status: string | null;
  }>(
    `SELECT id::text AS id,
            item_id::text AS item_id,
            rubric_version_id::text AS rubric_version_id,
            judge_model,
            outcome,
            cost_amount::text AS cost_amount,
            cost_status
     FROM evaluation_judge_findings
     WHERE run_id = $1`,
    [evaluationId],
  );
  const validatorsByItem = group(validators.rows, (row) => row.item_id);
  const findingsByItem = group(findings.rows, (row) => row.item_id);
  return {
    runId: first.run_id,
    status: first.status,
    sampleCategory: first.sample_category,
    profileVersionId: first.profile_version_id,
    profileName: first.profile_name,
    profileVersion: first.profile_version,
    rubricVersionId: first.rubric_version_id,
    rubricName: first.rubric_name,
    rubricVersion: first.rubric_version,
    items: rows.rows.map((row) => {
      const finding = findingsByItem.get(row.item_id)?.[0];
      return {
        itemId: row.item_id,
        sampleId: row.sample_id,
        itemStatus: row.item_status,
        itemReason: row.item_reason,
        sampleTaskCategory: row.sample_task_category,
        attempt:
          row.attempt_id === null || row.attempt_status === null
            ? null
            : {
                id: row.attempt_id,
                status: row.attempt_status,
                reasonCode: row.attempt_reason,
                originalDeployment: row.original_deployment ?? '',
                challengerDeployment: row.challenger_deployment ?? '',
                configVersion: row.config_version ?? 0,
                adapterVersion: row.adapter_version ?? 0,
                latencyMs: row.latency_ms,
                costAmount: row.cost_amount,
                costStatus: row.cost_status,
                challengerModel: row.challenger_model,
              },
        original:
          row.original_attempt_id === null || row.original_model === null
            ? null
            : {
                id: row.original_attempt_id,
                upstreamModel: row.original_model,
                durationMs: row.original_duration_ms,
                costAmount: row.original_cost_amount,
                costStatus: row.original_cost_status,
              },
        validators: (validatorsByItem.get(row.item_id) ?? []).flatMap((entry) => {
          if (!isCandidate(entry.candidate) || !isObjective(entry.result)) return [];
          return [{ id: entry.id, profileVersionId: entry.profile_version_id, candidate: entry.candidate, result: entry.result }];
        }),
        finding:
          finding === undefined || !isOutcome(finding.outcome)
            ? null
            : {
                id: finding.id,
                rubricVersionId: finding.rubric_version_id,
                judgeModel: finding.judge_model,
                outcome: finding.outcome,
                costAmount: finding.cost_amount,
                costStatus: finding.cost_status,
              },
      };
    }),
  };
}

function group<T>(rows: T[], key: (row: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = grouped.get(id);
    if (list === undefined) grouped.set(id, [row]);
    else list.push(row);
  }
  return grouped;
}

function isCandidate(value: string): value is Candidate {
  return value === 'original' || value === 'challenger';
}

function isObjective(value: string): value is ObjectiveResult {
  return value === 'pass' || value === 'fail' || value === 'not_applicable' || value === 'unknown';
}

function isOutcome(value: string): value is Outcome {
  return value === 'model_a' || value === 'model_b' || value === 'tie' || value === 'inconclusive' || value === 'unstable';
}
