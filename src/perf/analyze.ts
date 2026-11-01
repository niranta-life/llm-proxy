import { nearestRank } from './money.js';
import { agreePair, type AgreeResult } from './quality.js';

export type NumStat = {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

export type AttemptView = {
  kind: string;
  model: string;
  stream?: boolean;
  deployment?: string | null;
  wallMs?: number | null;
  ttftMs?: number | null;
  done?: boolean | null;
  error?: string | null;
  thoughts?: number | null;
  amount?: number | null;
  storedAmount?: number | null;
  itemId?: string | null;
  objectivePass?: boolean | null;
  concurrency?: number;
  usage?: { prompt?: number | null; completion?: number | null; total?: number | null };
  serverDurationMs?: number | null;
  serverTtftMs?: number | null;
  streamStatus?: string | null;
  cacheRead?: number | null;
  upstreamModel?: string | null;
  failureClass?: string | null;
  inputTokenEstimate?: number | null;
  selectedDeployment?: string | null;
  fallback?: boolean | null;
  judgeVote?: string | null;
  judgeOrder?: 'forward' | 'reverse' | null;
};

export type WaveView = {
  model: string;
  concurrency: number;
  count: number;
  ms: number;
};

export type ModelReport = {
  model: string;
  calls: number;
  failures: number;
  wall: NumStat;
  ttft: NumStat;
  generation: NumStat;
  server: NumStat;
  overhead: NumStat;
  outputPerSecond: NumStat;
  promptTokens: NumStat;
  completionTokens: NumStat;
  thoughts: NumStat;
  cost: number;
  unpriced: number;
  objectiveChecks: number;
  objectivePasses: number;
};

export type Analysis = {
  calls: number;
  failures: number;
  models: ModelReport[];
  totalCost: number;
  thoughtsShare: number | null;
  concurrency: { model: string; concurrency: number; wallP50: number | null; ratioToOne: number | null; callsPerSecond: number | null }[];
  judgeLabeled: number;
  judgeWins: number;
  judgeTies: number;
  judgeInconclusive: number;
  streams: number;
  streamsDone: number;
  findings: string[];
};

const MODEL_ORDER = ['openai', 'anthropic', 'xai', 'auto'];

export function numStat(values: readonly number[]): NumStat {
  if (values.length === 0) {
    return { n: 0, min: null, max: null, mean: null, p50: null, p95: null, p99: null };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    n: sorted.length,
    min: sorted[0] ?? null,
    max: sorted[sorted.length - 1] ?? null,
    mean: sum / sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
  };
}

function collectNumbers(rows: readonly AttemptView[], read: (row: AttemptView) => number | null): number[] {
  const out: number[] = [];
  for (const row of rows) {
    const value = read(row);
    if (value !== null && Number.isFinite(value)) out.push(value);
  }
  return out;
}

function costOf(row: AttemptView): number | null {
  if (typeof row.storedAmount === 'number') return row.storedAmount;
  if (typeof row.amount === 'number') return row.amount;
  return null;
}

function generationMs(row: AttemptView): number | null {
  if (typeof row.wallMs !== 'number' || typeof row.ttftMs !== 'number') return null;
  if (row.wallMs < row.ttftMs) return null;
  return row.wallMs - row.ttftMs;
}

function overheadMs(row: AttemptView): number | null {
  if (typeof row.wallMs !== 'number' || typeof row.serverDurationMs !== 'number') return null;
  return row.wallMs - row.serverDurationMs;
}

function tokensPerSecond(row: AttemptView): number | null {
  const completion = row.usage?.completion;
  const generation = generationMs(row);
  if (typeof completion !== 'number' || completion <= 0 || generation === null || generation <= 0) return null;
  return completion / (generation / 1000);
}

function modelReport(model: string, rows: readonly AttemptView[]): ModelReport {
  const load = rows.filter((row) => row.kind === 'load');
  const latencyRows = load.length > 0 ? load : rows;
  let cost = 0;
  let unpriced = 0;
  for (const row of rows) {
    const amount = costOf(row);
    if (amount === null) unpriced += 1;
    else cost += amount;
  }
  const checks = rows.filter((row) => typeof row.objectivePass === 'boolean');
  return {
    model,
    calls: rows.length,
    failures: rows.filter((row) => row.error !== null && row.error !== undefined).length,
    wall: numStat(collectNumbers(latencyRows, (row) => (typeof row.wallMs === 'number' ? row.wallMs : null))),
    ttft: numStat(collectNumbers(latencyRows, (row) => (typeof row.ttftMs === 'number' ? row.ttftMs : null))),
    generation: numStat(collectNumbers(latencyRows, generationMs)),
    server: numStat(collectNumbers(latencyRows, (row) => (typeof row.serverDurationMs === 'number' ? row.serverDurationMs : null))),
    overhead: numStat(collectNumbers(latencyRows, overheadMs)),
    outputPerSecond: numStat(collectNumbers(latencyRows, tokensPerSecond)),
    promptTokens: numStat(collectNumbers(rows, (row) => (typeof row.usage?.prompt === 'number' ? row.usage.prompt : null))),
    completionTokens: numStat(collectNumbers(rows, (row) => (typeof row.usage?.completion === 'number' ? row.usage.completion : null))),
    thoughts: numStat(collectNumbers(rows, (row) => (typeof row.thoughts === 'number' ? row.thoughts : null))),
    cost,
    unpriced,
    objectiveChecks: checks.length,
    objectivePasses: checks.filter((row) => row.objectivePass === true).length,
  };
}

function ms(value: number | null): string {
  return value === null ? 'not available' : value.toFixed(3);
}

function money(value: number): string {
  return value.toFixed(8);
}

function judgeScore(rows: readonly AttemptView[]): { labeled: number; wins: number; ties: number; inconclusive: number } {
  const byItem = new Map<string, { forward?: string | null; reverse?: string | null }>();
  for (const row of rows) {
    if (row.kind !== 'judge' || row.itemId === null || row.itemId === undefined) continue;
    if (row.judgeVote === undefined) continue;
    const slot = byItem.get(row.itemId) ?? {};
    if (row.judgeOrder === 'reverse') slot.reverse = row.judgeVote;
    else slot.forward = row.judgeVote;
    byItem.set(row.itemId, slot);
  }
  let labeled = 0;
  let wins = 0;
  let ties = 0;
  let inconclusive = 0;
  for (const slot of byItem.values()) {
    if (slot.forward === undefined || slot.reverse === undefined) continue;
    labeled += 1;
    const agreed: AgreeResult = agreePair(
      slot.forward as 'X' | 'Y' | 'tie' | 'inconclusive' | null,
      slot.reverse as 'X' | 'Y' | 'tie' | 'inconclusive' | null,
    );
    if (agreed === 'anthropic' || agreed === 'xai') wins += 1;
    else if (agreed === 'tie') ties += 1;
    else inconclusive += 1;
  }
  return { labeled, wins, ties, inconclusive };
}

export function analyzeAttempts(rows: readonly AttemptView[], waves: readonly WaveView[] = []): Analysis {
  const names = new Set(rows.map((row) => row.model));
  const ordered = [
    ...MODEL_ORDER.filter((model) => names.has(model)),
    ...[...names].filter((model) => !MODEL_ORDER.includes(model)).sort(),
  ];
  const models = ordered.map((model) => modelReport(model, rows.filter((row) => row.model === model)));
  const totalCost = models.reduce((sum, model) => sum + model.cost, 0);
  let thoughtSum = 0;
  let totalSum = 0;
  let thoughtRows = 0;
  for (const row of rows) {
    if (row.model !== 'xai' || typeof row.thoughts !== 'number' || typeof row.usage?.total !== 'number') continue;
    if (row.usage.total <= 0) continue;
    thoughtSum += row.thoughts;
    totalSum += row.usage.total;
    thoughtRows += 1;
  }
  const thoughtsShare = thoughtRows > 0 && totalSum > 0 ? thoughtSum / totalSum : null;
  const concurrency: Analysis['concurrency'] = [];
  for (const model of ordered) {
    const load = rows.filter((row) => row.model === model && row.kind === 'load' && typeof row.concurrency === 'number');
    const levels = [...new Set(load.map((row) => row.concurrency as number))].sort((a, b) => a - b);
    const baselineValues = load.filter((row) => row.concurrency === 1 && typeof row.wallMs === 'number').map((row) => row.wallMs as number);
    const baseline = numStat(baselineValues).p50;
    for (const level of levels) {
      const atLevel = load.filter((row) => row.concurrency === level && typeof row.wallMs === 'number').map((row) => row.wallMs as number);
      const wallP50 = numStat(atLevel).p50;
      const waveRows = waves.filter((wave) => wave.model === model && wave.concurrency === level);
      const waveCount = waveRows.reduce((sum, wave) => sum + wave.count, 0);
      const waveMs = waveRows.reduce((sum, wave) => sum + wave.ms, 0);
      concurrency.push({
        model,
        concurrency: level,
        wallP50,
        ratioToOne: wallP50 !== null && baseline !== null && baseline > 0 ? wallP50 / baseline : null,
        callsPerSecond: waveMs > 0 ? (waveCount / waveMs) * 1000 : null,
      });
    }
  }
  const judge = judgeScore(rows);
  const streams = rows.filter((row) => row.stream === true);
  const streamsDone = streams.filter((row) => row.done === true).length;
  const findings = buildFindings({
    rows,
    models,
    totalCost,
    thoughtsShare,
    concurrency,
    judge,
    streams: streams.length,
    streamsDone,
  });
  return {
    calls: rows.length,
    failures: rows.filter((row) => row.error !== null && row.error !== undefined).length,
    models,
    totalCost,
    thoughtsShare,
    concurrency,
    judgeLabeled: judge.labeled,
    judgeWins: judge.wins,
    judgeTies: judge.ties,
    judgeInconclusive: judge.inconclusive,
    streams: streams.length,
    streamsDone,
    findings,
  };
}

function buildFindings(input: {
  rows: readonly AttemptView[];
  models: readonly ModelReport[];
  totalCost: number;
  thoughtsShare: number | null;
  concurrency: Analysis['concurrency'];
  judge: { labeled: number; wins: number; ties: number; inconclusive: number };
  streams: number;
  streamsDone: number;
}): string[] {
  const lines: string[] = [];
  const ranked = input.models
    .filter((model) => model.model !== 'auto' && model.wall.p50 !== null && model.calls > 0)
    .sort((a, b) => (a.wall.p50 ?? 0) - (b.wall.p50 ?? 0));
  const fastest = ranked[0];
  const slowest = ranked[ranked.length - 1];
  if (fastest !== undefined && slowest !== undefined && fastest.model !== slowest.model) {
    lines.push(
      `${fastest.model} had the lowest median time to finish at ${ms(fastest.wall.p50)} ms. ${slowest.model} had the highest median time to finish at ${ms(slowest.wall.p50)} ms.`,
    );
  }
  for (const model of input.models) {
    if (model.wall.n === 0) continue;
    const callWord = model.calls === 1 ? 'call' : 'calls';
    lines.push(
      `${model.model} recorded ${model.calls} ${callWord}. Median time to finish was ${ms(model.wall.p50)} ms. Median time to first text was ${ms(model.ttft.p50)} ms.`,
    );
    if (model.wall.p50 !== null && model.wall.p95 !== null && model.wall.p50 > 0 && model.wall.p95 / model.wall.p50 >= 2) {
      const ratio = (model.wall.p95 / model.wall.p50).toFixed(2);
      lines.push(
        `Some ${model.model} calls were much slower than the median. 95 percent of ${model.model} calls finished within ${ratio} times the median.`,
      );
    }
    if (model.overhead.p50 !== null) {
      lines.push(
        `For ${model.model}, the time we measured minus the time the provider recorded had a median of ${ms(model.overhead.p50)} ms.`,
      );
    }
    if (model.outputPerSecond.p50 !== null) {
      lines.push(`${model.model} had a median of ${model.outputPerSecond.p50.toFixed(2)} output tokens per second.`);
    }
    if (model.objectiveChecks > 0) {
      lines.push(`${model.model} passed ${model.objectivePasses} of ${model.objectiveChecks} answer checks.`);
    }
  }
  for (const point of input.concurrency) {
    if (point.concurrency <= 1 || point.ratioToOne === null) continue;
    lines.push(
      `At ${point.concurrency} calls at once, the median time to finish for ${point.model} was ${point.ratioToOne.toFixed(2)} times the median with 1 call at once.`,
    );
    if (point.callsPerSecond !== null) {
      lines.push(
        `${point.model} completed ${point.callsPerSecond.toFixed(2)} calls per second at ${point.concurrency} calls at once.`,
      );
    }
  }
  if (input.totalCost > 0) {
    const parts = [`The saved cost was ${money(input.totalCost)} USD.`];
    for (const model of input.models) {
      if (model.cost <= 0) continue;
      const percent = ((model.cost / input.totalCost) * 100).toFixed(1);
      parts.push(`${model.model} cost ${money(model.cost)} USD.`);
      parts.push(`That was ${percent} percent of the saved cost.`);
    }
    lines.push(parts.join(' '));
  }
  if (input.thoughtsShare !== null) {
    lines.push(`xAI thinking tokens were ${(input.thoughtsShare * 100).toFixed(1)} percent of xAI total tokens.`);
  }
  const estimateGaps: number[] = [];
  for (const row of input.rows) {
    if (typeof row.usage?.prompt !== 'number' || typeof row.inputTokenEstimate !== 'number') continue;
    estimateGaps.push(row.usage.prompt - row.inputTokenEstimate);
  }
  const gap = numStat(estimateGaps);
  if (gap.p50 !== null) {
    const size = Math.abs(gap.p50).toFixed(1);
    if (gap.p50 > 0) lines.push(`The median prompt had ${size} more tokens than the saved estimate.`);
    else if (gap.p50 < 0) lines.push(`The median prompt had ${size} fewer tokens than the saved estimate.`);
    else lines.push('The median prompt had the same number of tokens as the saved estimate.');
  } else if (input.rows.length > 0) {
    lines.push('The saved token estimate was missing for these calls.');
  }
  if (input.streams > 0) {
    lines.push(`${input.streamsDone} of ${input.streams} streamed calls finished cleanly.`);
  }
  const secondAttempts = input.rows.filter((row) => row.fallback === true).length;
  if (input.rows.length > 0) {
    lines.push(secondAttempts === 0 ? 'No call used a second attempt.' : `${secondAttempts} calls used a second attempt.`);
  }
  const drift = input.rows.filter(
    (row) =>
      row.model !== 'auto'
      && row.selectedDeployment !== null
      && row.selectedDeployment !== undefined
      && row.deployment !== null
      && row.deployment !== undefined
      && row.selectedDeployment !== row.deployment,
  );
  if (drift.length > 0) {
    lines.push(`${drift.length} calls reported one deployment. The saved record named a different deployment.`);
  }
  if (input.judge.labeled === 0) {
    const judgeRows = input.rows.filter((row) => row.kind === 'judge').length;
    lines.push(judgeRows > 0 ? 'The judge\'s results were not saved on this run.' : 'This run stored no judge pairs.');
  } else {
    lines.push(
      `The judge picked the same winner both times on ${input.judge.wins} of ${input.judge.labeled} pairs. Ties were ${input.judge.ties}. Inconclusive pairs were ${input.judge.inconclusive}.`,
    );
  }
  const serverRows = input.rows.filter((row) => typeof row.serverDurationMs === 'number').length;
  if (serverRows === 0 && input.rows.length > 0) {
    lines.push('The time the provider recorded was not read.');
  }
  return lines;
}

export function renderAnalysis(analysis: Analysis, comparison: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push('# Performance analysis');
  lines.push('');
  lines.push(`The run recorded ${analysis.calls} calls. ${analysis.failures} calls failed.`);
  lines.push('');
  lines.push('## By model');
  lines.push('');
  lines.push('| Model | Calls | Failures | Median time to finish (ms) | 95 percent finished by (ms) | Median time to first text (ms) | Median output tokens per second | Cost (USD) | Checks passed |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const model of analysis.models) {
    const speed = model.outputPerSecond.p50 === null ? 'not available' : model.outputPerSecond.p50.toFixed(2);
    const checks = model.objectiveChecks === 0 ? 'none' : `${model.objectivePasses} of ${model.objectiveChecks}`;
    lines.push(
      `| ${model.model} | ${model.calls} | ${model.failures} | ${ms(model.wall.p50)} | ${ms(model.wall.p95)} | ${ms(model.ttft.p50)} | ${speed} | ${money(model.cost)} | ${checks} |`,
    );
  }
  lines.push('');
  lines.push('## Calls at once');
  lines.push('');
  lines.push('| Model | Calls at once | Median time to finish (ms) | As a multiple of the 1-call median | Calls per second |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const point of analysis.concurrency) {
    lines.push(
      `| ${point.model} | ${point.concurrency} | ${ms(point.wallP50)} | ${point.ratioToOne === null ? 'not available' : point.ratioToOne.toFixed(2)} | ${point.callsPerSecond === null ? 'not available' : point.callsPerSecond.toFixed(2)} |`,
    );
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  for (const finding of analysis.findings) {
    lines.push(finding);
    lines.push('');
  }
  if (comparison.length > 0) {
    lines.push('## Previous run');
    lines.push('');
    for (const line of comparison) {
      lines.push(line);
      lines.push('');
    }
  }
  return lines.join('\n');
}

export function compareHistory(
  previous: { wallP50: number | null; spend: number; errorRate: number } | null,
  current: { wallP50: number | null; spend: number; errorRate: number },
): string[] {
  if (previous === null) return ['No earlier run of this profile is on file.'];
  const lines: string[] = [];
  if (previous.wallP50 !== null && current.wallP50 !== null) {
    lines.push(moved('Median time to finish', current.wallP50 - previous.wallP50, 3, 'ms', 'slower', 'faster'));
  }
  lines.push(moved('Cost', current.spend - previous.spend, 8, 'USD', 'higher', 'lower'));
  lines.push(moved('The share of failed calls', current.errorRate - previous.errorRate, 4, '', 'higher', 'lower'));
  return lines;
}

function moved(subject: string, delta: number, digits: number, unit: string, up: string, down: string): string {
  if (delta === 0) return `${subject} was the same as the previous run.`;
  const direction = delta > 0 ? up : down;
  const amount = Math.abs(delta).toFixed(digits);
  if (unit.length === 0) return `${subject} was ${amount} ${direction} than the previous run.`;
  return `${subject} was ${amount} ${unit} ${direction} than the previous run.`;
}
