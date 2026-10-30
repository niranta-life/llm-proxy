import { createHash } from 'node:crypto';
import { scaleDecimal } from './evaluation-preflight.js';
import { invalidRequest } from './errors.js';
import { isTaskCategory, type TaskCategory } from './task-categories.js';

const SCALE = 1_000_000_000_000n;
export const SAMPLE_ESTIMATE = '0.01';
export const SCHEDULE_DAILY_CEILING = '1';
export const SCHEDULE_MONTHLY_CEILING = '20';
export const SCHEDULE_CANDIDATE_CAP = 200;
export const JUDGE_CALLS_PER_SAMPLE = 2;

export const SKIP_REASONS = [
  'scheduler_disabled',
  'tenant_not_enabled',
  'schedule_disabled',
  'global_kill_switch',
  'no_eligible_samples',
  'budget_too_small',
  'judge_budget_exhausted',
  'production_capacity_constrained',
  'challenger_call_limit',
  'concurrent_job_limit',
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const WRITE_KEYS = new Set([
  'enabled',
  'dailyLimit',
  'monthlyLimit',
  'perRunMaxExpense',
  'maxChallengerCalls',
  'maxJudgeCalls',
  'maxConcurrentJobs',
  'maxDurationMs',
  'maxSamples',
  'challengerDeployment',
  'judgeDeployment',
  'profileVersionId',
  'rubricVersionId',
  'sampleCategory',
]);

export type ScheduleWrite = {
  enabled: boolean;
  dailyLimit: string;
  monthlyLimit: string;
  perRunMaxExpense: string;
  maxChallengerCalls: number;
  maxJudgeCalls: number;
  maxConcurrentJobs: number;
  maxDurationMs: number;
  maxSamples: number;
  challengerDeployment: string;
  judgeDeployment: string | null;
  profileVersionId: string | null;
  rubricVersionId: string | null;
  sampleCategory: TaskCategory;
};

export type CandidateFact = {
  id: string;
  workloadVolume: number;
  coverage: number;
  evidenceAgeDays: number | null;
  modelChanged: boolean;
  configChanged: boolean;
  priceChanged: boolean;
  qualityRegression: boolean;
  efficiencyMicros: bigint;
  efficiencyKnown: boolean;
  uncertainty: number;
};

export type SpendFacts = {
  tenantDaily: string;
  tenantMonthly: string;
  globalDaily: string;
  globalMonthly: string;
  globalDailyLimit: string;
  globalMonthlyLimit: string;
  challengerCallsToday: number;
  judgeCallsToday: number;
  openRuns: number;
};

export type ScheduleChoice = {
  action: 'run' | 'skip';
  skipReason: SkipReason | null;
  reasonCodes: string[];
  sampleIds: string[];
  reservedAmount: string;
  challengerCalls: number;
  judgeCalls: number;
  fingerprint: string;
};

export type DriftRun = {
  id: string;
  createdAt: string;
  taskCategory: string;
  profileVersionId: string | null;
  rubricVersionId: string | null;
  sampleIds: string[];
  pass: number;
  fail: number;
  schemaFail: number;
  schemaChecked: number;
  latencies: number[];
  completedAttempts: number;
  attempts: number;
  upstreamModels: string[];
  configVersions: number[];
  priceVersionIds: string[];
};

export type DriftDeployment = {
  name: string;
  upstreamModel: string;
  configVersion: number;
  createdAt: string;
};

export type DriftSample = {
  category: string;
  createdAt: string;
};

export type DriftStatement = {
  taskCategory: string;
  profileVersionId: string | null;
  rubricVersionId: string | null;
  comparable: boolean;
  limit: string | null;
  qualityDrift: boolean | null;
  schemaValidityRegression: boolean | null;
  latencyRegression: boolean | null;
  reliabilityRegression: boolean | null;
  modelVersionChanged: boolean | null;
  priceVersionChanged: boolean | null;
  newModelDeployed: boolean | null;
};

export type DriftReport = {
  asOf: string;
  statements: DriftStatement[];
  workloadMixChange: boolean;
  limits: string[];
  historical: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function money(value: string): bigint {
  return scaleDecimal(value) ?? 0n;
}

export function formatMoney(value: bigint): string {
  const whole = value / SCALE;
  const fraction = (value % SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return fraction.length === 0 ? whole.toString() : `${whole.toString()}.${fraction}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function integerIn(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function deployment(value: unknown): string | null {
  if (typeof value !== 'string' || !NAME.test(value) || value === 'auto') return null;
  return value;
}

export function parseScheduleWrite(body: unknown): ScheduleWrite {
  if (!isRecord(body)) throw invalidRequest('body', 'invalid_parameter', 'The schedule body is invalid.');
  for (const key of Object.keys(body)) {
    if (!WRITE_KEYS.has(key)) throw invalidRequest(key, 'invalid_parameter', 'The schedule body is invalid.');
  }
  if (typeof body.enabled !== 'boolean') throw invalidRequest('enabled', 'invalid_parameter', 'enabled is invalid.');
  if (typeof body.dailyLimit !== 'string' || scaleDecimal(body.dailyLimit) === null) {
    throw invalidRequest('daily_limit', 'invalid_parameter', 'dailyLimit is invalid.');
  }
  if (typeof body.monthlyLimit !== 'string' || scaleDecimal(body.monthlyLimit) === null) {
    throw invalidRequest('monthly_limit', 'invalid_parameter', 'monthlyLimit is invalid.');
  }
  if (typeof body.perRunMaxExpense !== 'string' || scaleDecimal(body.perRunMaxExpense) === null) {
    throw invalidRequest('per_run_max_expense', 'invalid_parameter', 'perRunMaxExpense is invalid.');
  }
  const daily = money(body.dailyLimit);
  const monthly = money(body.monthlyLimit);
  const perRun = money(body.perRunMaxExpense);
  if (daily <= 0n || daily > money(SCHEDULE_DAILY_CEILING)) {
    throw invalidRequest('daily_limit', 'invalid_parameter', 'dailyLimit is above the small daily ceiling.');
  }
  if (monthly < daily || monthly > money(SCHEDULE_MONTHLY_CEILING)) {
    throw invalidRequest('monthly_limit', 'invalid_parameter', 'monthlyLimit is invalid.');
  }
  if (perRun <= 0n || perRun > daily) {
    throw invalidRequest('per_run_max_expense', 'invalid_parameter', 'perRunMaxExpense is invalid.');
  }
  const maxChallengerCalls = integerIn(body.maxChallengerCalls, 1, 100);
  const maxJudgeCalls = integerIn(body.maxJudgeCalls, 0, 40);
  const maxConcurrentJobs = integerIn(body.maxConcurrentJobs, 1, 10);
  const maxDurationMs = integerIn(body.maxDurationMs, 1000, 600_000);
  const maxSamples = integerIn(body.maxSamples, 1, 20);
  if (
    maxChallengerCalls === null ||
    maxJudgeCalls === null ||
    maxConcurrentJobs === null ||
    maxDurationMs === null ||
    maxSamples === null
  ) {
    throw invalidRequest('limits', 'invalid_parameter', 'A schedule limit is invalid.');
  }
  const challengerDeployment = deployment(body.challengerDeployment);
  if (challengerDeployment === null) {
    throw invalidRequest('challenger_deployment', 'invalid_parameter', 'challengerDeployment is invalid.');
  }
  let judgeDeployment: string | null = null;
  if (body.judgeDeployment !== undefined && body.judgeDeployment !== null) {
    judgeDeployment = deployment(body.judgeDeployment);
    if (judgeDeployment === null) {
      throw invalidRequest('judge_deployment', 'invalid_parameter', 'judgeDeployment is invalid.');
    }
  }
  let profileVersionId: string | null = null;
  if (body.profileVersionId !== undefined && body.profileVersionId !== null) {
    if (typeof body.profileVersionId !== 'string' || !UUID.test(body.profileVersionId)) {
      throw invalidRequest('profile_version_id', 'invalid_parameter', 'profileVersionId is invalid.');
    }
    profileVersionId = body.profileVersionId.toLowerCase();
  }
  let rubricVersionId: string | null = null;
  if (body.rubricVersionId !== undefined && body.rubricVersionId !== null) {
    if (judgeDeployment === null) {
      throw invalidRequest('judge_deployment', 'invalid_parameter', 'A rubric requires a judge deployment.');
    }
    if (typeof body.rubricVersionId !== 'string' || !UUID.test(body.rubricVersionId)) {
      throw invalidRequest('rubric_version_id', 'invalid_parameter', 'rubricVersionId is invalid.');
    }
    rubricVersionId = body.rubricVersionId.toLowerCase();
  }
  if (typeof body.sampleCategory !== 'string' || !isTaskCategory(body.sampleCategory)) {
    throw invalidRequest('sample_category', 'invalid_parameter', 'sampleCategory is invalid.');
  }
  return {
    enabled: body.enabled,
    dailyLimit: formatMoney(daily),
    monthlyLimit: formatMoney(monthly),
    perRunMaxExpense: formatMoney(perRun),
    maxChallengerCalls,
    maxJudgeCalls,
    maxConcurrentJobs,
    maxDurationMs,
    maxSamples,
    challengerDeployment,
    judgeDeployment,
    profileVersionId,
    rubricVersionId,
    sampleCategory: body.sampleCategory,
  };
}

export function scheduleRequestHash(write: ScheduleWrite): string {
  return sha256(JSON.stringify(write));
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}

export function utcMonthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

export function tickRunKey(day: string): string {
  return `t${day}`;
}

export function tickSkipKey(day: string, reason: SkipReason): string {
  return `s${day}${reason}`;
}

function compareCandidates(left: CandidateFact, right: CandidateFact): number {
  const version = (row: CandidateFact): number => (row.modelChanged || row.configChanged || row.priceChanged ? 1 : 0);
  const age = (row: CandidateFact): number => (row.evidenceAgeDays === null ? 100_000 : row.evidenceAgeDays);
  const steps: Array<(row: CandidateFact) => number | string> = [
    (row) => (row.qualityRegression ? 1 : 0),
    version,
    age,
    (row) => row.uncertainty,
    (row) => -row.coverage,
    (row) => row.workloadVolume,
    (row) => Number(row.efficiencyMicros),
    (row) => -Number(money(SAMPLE_ESTIMATE)),
  ];
  for (const step of steps) {
    const delta = Number(step(left)) - Number(step(right));
    if (delta !== 0) return delta > 0 ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function remaining(limit: string, used: string): bigint {
  const value = money(limit) - money(used);
  return value > 0n ? value : 0n;
}

function skip(reason: SkipReason, fingerprint: string): ScheduleChoice {
  return {
    action: 'skip',
    skipReason: reason,
    reasonCodes: [reason],
    sampleIds: [],
    reservedAmount: '0',
    challengerCalls: 0,
    judgeCalls: 0,
    fingerprint,
  };
}

export function decideSchedule(input: {
  namedTenant: boolean;
  schedulerEnabled: boolean;
  kill: boolean;
  enabled: boolean;
  write: ScheduleWrite | null;
  productionConstrained: boolean;
  spend: SpendFacts;
  candidates: readonly CandidateFact[];
  day: string;
}): ScheduleChoice {
  const fingerprint = sha256(
    JSON.stringify({
      day: input.day,
      named: input.namedTenant,
      scheduler: input.schedulerEnabled,
      kill: input.kill,
      enabled: input.enabled,
      write: input.write,
      capacity: input.productionConstrained,
      candidates: input.candidates.map((row) => ({
        id: row.id,
        workloadVolume: row.workloadVolume,
        coverage: row.coverage,
        evidenceAgeDays: row.evidenceAgeDays,
        modelChanged: row.modelChanged,
        configChanged: row.configChanged,
        priceChanged: row.priceChanged,
        qualityRegression: row.qualityRegression,
        efficiency: row.efficiencyMicros.toString(),
        uncertainty: row.uncertainty,
      })),
      openRuns: input.spend.openRuns,
      calls: [input.spend.challengerCallsToday, input.spend.judgeCallsToday],
      money: [
        input.spend.tenantDaily,
        input.spend.tenantMonthly,
        input.spend.globalDaily,
        input.spend.globalMonthly,
      ],
    }),
  );
  if (!input.schedulerEnabled) return skip('scheduler_disabled', fingerprint);
  if (!input.namedTenant) return skip('tenant_not_enabled', fingerprint);
  if (!input.enabled || input.write === null) return skip('schedule_disabled', fingerprint);
  if (input.kill) return skip('global_kill_switch', fingerprint);
  if (input.productionConstrained) return skip('production_capacity_constrained', fingerprint);
  if (input.spend.openRuns >= input.write.maxConcurrentJobs) return skip('concurrent_job_limit', fingerprint);
  const unit = money(SAMPLE_ESTIMATE);
  const affordable = [
    remaining(input.write.dailyLimit, input.spend.tenantDaily),
    remaining(input.write.monthlyLimit, input.spend.tenantMonthly),
    remaining(input.spend.globalDailyLimit, input.spend.globalDaily),
    remaining(input.spend.globalMonthlyLimit, input.spend.globalMonthly),
    money(input.write.perRunMaxExpense),
  ].reduce((min, value) => (value < min ? value : min), money(input.write.perRunMaxExpense));
  const byMoney = Number(affordable / unit);
  const callRoom = input.write.maxChallengerCalls - input.spend.challengerCallsToday;
  if (input.candidates.length === 0) return skip('no_eligible_samples', fingerprint);
  if (byMoney < 1) return skip('budget_too_small', fingerprint);
  if (callRoom < 1) return skip('challenger_call_limit', fingerprint);
  const judgeRoom = input.write.maxJudgeCalls - input.spend.judgeCallsToday;
  const judging = input.write.rubricVersionId !== null;
  if (judging && judgeRoom < JUDGE_CALLS_PER_SAMPLE) return skip('judge_budget_exhausted', fingerprint);
  const judgeCap = judging ? Math.floor(judgeRoom / JUDGE_CALLS_PER_SAMPLE) : input.write.maxSamples;
  const count = Math.min(input.write.maxSamples, input.candidates.length, byMoney, callRoom, judgeCap);
  if (count < 1) return skip(judging ? 'judge_budget_exhausted' : 'budget_too_small', fingerprint);
  const selected = [...input.candidates].sort(compareCandidates).slice(0, count);
  const reasonCodes: string[] = ['bounded_sample'];
  if (selected.some((row) => row.evidenceAgeDays === null || row.coverage === 0)) reasonCodes.push('new_samples');
  if (selected.some((row) => row.evidenceAgeDays !== null && row.evidenceAgeDays >= 1)) reasonCodes.push('stale_evidence');
  if (selected.some((row) => row.qualityRegression)) reasonCodes.push('quality_regression');
  if (selected.some((row) => row.modelChanged || row.configChanged || row.priceChanged)) reasonCodes.push('version_change');
  if (selected.some((row) => row.coverage === 0)) reasonCodes.push('low_coverage');
  if (selected.some((row) => row.efficiencyKnown && row.efficiencyMicros > 0n)) reasonCodes.push('efficiency_improvement');
  if (selected.some((row) => row.uncertainty >= 0.5)) reasonCodes.push('high_uncertainty');
  if (selected.some((row) => row.workloadVolume > 0)) reasonCodes.push('workload_volume');
  return {
    action: 'run',
    skipReason: null,
    reasonCodes,
    sampleIds: selected.map((row) => row.id),
    reservedAmount: formatMoney(unit * BigInt(selected.length)),
    challengerCalls: selected.length,
    judgeCalls: judging ? selected.length * JUDGE_CALLS_PER_SAMPLE : 0,
    fingerprint,
  };
}

export function productionCapacityConstrained(input: {
  mode: string | null;
  limit: number | null;
  inUse: number;
}): boolean {
  return input.mode === 'hard' && input.limit !== null && input.inUse >= input.limit;
}

function p95(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(0.95 * sorted.length) - 1;
  return sorted[Math.max(0, index)] ?? null;
}

function worseRate(laterNum: number, laterDen: number, earlierNum: number, earlierDen: number): boolean | null {
  if (laterDen <= 0 || earlierDen <= 0) return null;
  return laterNum * earlierDen < earlierNum * laterDen;
}

function population(ids: readonly string[]): string {
  return [...ids].sort().join(',');
}

function statementFor(latest: DriftRun, earlier: DriftRun | null, deployments: readonly DriftDeployment[]): DriftStatement {
  const base = {
    taskCategory: latest.taskCategory,
    profileVersionId: latest.profileVersionId,
    rubricVersionId: latest.rubricVersionId,
  };
  const deployedAfter =
    earlier !== null &&
    deployments.some((row) => row.createdAt > earlier.createdAt && row.createdAt <= latest.createdAt);
  if (earlier === null) {
    return {
      ...base,
      comparable: false,
      limit: 'insufficient_history',
      qualityDrift: null,
      schemaValidityRegression: null,
      latencyRegression: null,
      reliabilityRegression: null,
      modelVersionChanged: null,
      priceVersionChanged: null,
      newModelDeployed: deployments.some((row) => row.createdAt > latest.createdAt) ? true : null,
    };
  }
  if (population(latest.sampleIds) !== population(earlier.sampleIds)) {
    return {
      ...base,
      comparable: false,
      limit: 'mixed_population',
      qualityDrift: null,
      schemaValidityRegression: null,
      latencyRegression: null,
      reliabilityRegression: null,
      modelVersionChanged: null,
      priceVersionChanged: null,
      newModelDeployed: deployedAfter ? true : null,
    };
  }
  const laterLatency = p95(latest.latencies);
  const earlierLatency = p95(earlier.latencies);
  const latencyRegression =
    laterLatency !== null && earlierLatency !== null ? laterLatency * 10 > earlierLatency * 11 : null;
  const models = (row: DriftRun): string => [...row.upstreamModels].sort().join(',');
  const configs = (row: DriftRun): string => [...row.configVersions].sort().join(',');
  const prices = (row: DriftRun): string => [...row.priceVersionIds].sort().join(',');
  return {
    ...base,
    comparable: true,
    limit: null,
    qualityDrift: worseRate(latest.pass, latest.pass + latest.fail, earlier.pass, earlier.pass + earlier.fail),
    schemaValidityRegression: worseRate(
      latest.schemaChecked - latest.schemaFail,
      latest.schemaChecked,
      earlier.schemaChecked - earlier.schemaFail,
      earlier.schemaChecked,
    ),
    latencyRegression,
    reliabilityRegression: worseRate(
      latest.completedAttempts,
      latest.attempts,
      earlier.completedAttempts,
      earlier.attempts,
    ),
    modelVersionChanged: models(latest) !== models(earlier) || configs(latest) !== configs(earlier),
    priceVersionChanged: prices(latest) !== prices(earlier),
    newModelDeployed: deployedAfter,
  };
}

function workloadChanged(samples: readonly DriftSample[], asOfMs: number): boolean {
  const day = 86_400_000;
  const recent = new Map<string, number>();
  const prior = new Map<string, number>();
  for (const sample of samples) {
    const at = Date.parse(sample.createdAt);
    if (!Number.isFinite(at) || at > asOfMs) continue;
    const bucket = at > asOfMs - 7 * day ? recent : at > asOfMs - 14 * day ? prior : null;
    if (bucket === null) continue;
    bucket.set(sample.category, (bucket.get(sample.category) ?? 0) + 1);
  }
  const recentTotal = [...recent.values()].reduce((sum, value) => sum + value, 0);
  const priorTotal = [...prior.values()].reduce((sum, value) => sum + value, 0);
  if (recentTotal === 0 || priorTotal === 0) return false;
  const categories = new Set([...recent.keys(), ...prior.keys()]);
  for (const category of categories) {
    const recentShare = (recent.get(category) ?? 0) / recentTotal;
    const priorShare = (prior.get(category) ?? 0) / priorTotal;
    if (Math.abs(recentShare - priorShare) >= 0.1) return true;
  }
  return false;
}

export function stateDrift(input: {
  asOf: string;
  runs: readonly DriftRun[];
  deployments: readonly DriftDeployment[];
  samples: readonly DriftSample[];
}): DriftReport {
  const asOfMs = Date.parse(input.asOf);
  const runs = input.runs
    .filter((run) => Date.parse(run.createdAt) <= asOfMs)
    .sort((left, right) => (left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : left.id < right.id ? -1 : 1));
  const groups = new Map<string, DriftRun[]>();
  for (const run of runs) {
    const key = `${run.taskCategory}|${run.profileVersionId ?? ''}|${run.rubricVersionId ?? ''}`;
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }
  const statements: DriftStatement[] = [];
  for (const list of groups.values()) {
    const latest = list.at(-1);
    if (latest === undefined) continue;
    const earlier = list.length >= 2 ? (list.at(-2) ?? null) : null;
    statements.push(statementFor(latest, earlier, input.deployments.filter((row) => Date.parse(row.createdAt) <= asOfMs)));
  }
  const limits = new Set<string>();
  const categories = new Set(runs.map((run) => run.taskCategory));
  if (categories.size > 1) limits.add('mixed_task_category');
  for (const category of categories) {
    const inCategory = runs.filter((run) => run.taskCategory === category);
    if (new Set(inCategory.map((run) => run.profileVersionId ?? '')).size > 1) limits.add('mixed_profile');
    if (new Set(inCategory.map((run) => run.rubricVersionId ?? '')).size > 1) limits.add('mixed_rubric_version');
  }
  for (const statement of statements) {
    if (statement.limit !== null) limits.add(statement.limit);
  }
  if (runs.length === 0) limits.add('insufficient_history');
  return {
    asOf: input.asOf,
    statements,
    workloadMixChange: workloadChanged(
      input.samples.filter((sample) => Date.parse(sample.createdAt) <= asOfMs),
      asOfMs,
    ),
    limits: [...limits].sort(),
    historical: true,
  };
}
