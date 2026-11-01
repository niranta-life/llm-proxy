import { describe, expect, it } from 'vitest';
import {
  JUDGE_OUTPUT_TOKENS,
  RESERVE,
  RATES,
  SpendLedger,
  deriveThoughts,
  estimateUsd,
  priceCall,
  nearestRank,
  rejectMaxUsd,
  reserveFor,
  smokeCeilings,
} from '../src/perf/money.js';
import {
  JUDGE_SYSTEM_PROMPT,
  QUALITY_ITEMS,
  agreePair,
  buildJudgeMessages,
  judgePromptOmitsProviders,
  learningCurve,
  objectivePass,
} from '../src/perf/quality.js';
import { barChart, lineChart } from '../src/perf/svg.js';
import { analyzeAttempts, compareHistory, numStat } from '../src/perf/analyze.js';
import { enrichSql, foldRows, parseEnrich } from '../src/perf/telemetry.js';
import { applySampleGuard, buildPlan } from '../src/perf/cli.js';
import { JUDGE_CRITERIA, parseJudgeResponse } from '../src/inference/judge.js';

describe('perf money', () => {
  it('nearestRank uses ceil(p/100*n)-1 and returns null for empty', () => {
    expect(nearestRank([], 50)).toBeNull();
    expect(nearestRank([10, 20, 30, 40], 50)).toBe(20);
    expect(nearestRank([10, 20, 30, 40], 95)).toBe(40);
    expect(nearestRank([10], 1)).toBe(10);
  });

  it('tryReserve stops at the cap', () => {
    const ledger = new SpendLedger(0.05, smokeCeilings());
    expect(ledger.tryReserve('openai', RESERVE.openai)).toBe(true);
    expect(ledger.tryReserve('openai', RESERVE.openai)).toBe(true);
    // spent+reserved would exceed after enough openai reserves of 0.00002 under 0.05,
    // use a large reserve against a tiny remaining budget
    const tight = new SpendLedger(0.00003, smokeCeilings());
    expect(tight.tryReserve('openai', RESERVE.openai)).toBe(true);
    expect(tight.tryReserve('openai', RESERVE.openai)).toBe(false);
  });

  it('unknown cost holds the reserve in spent', () => {
    const ledger = new SpendLedger(1, smokeCeilings());
    expect(ledger.tryReserve('anthropic', RESERVE.anthropic)).toBe(true);
    expect(ledger.reserved).toBe(RESERVE.anthropic);
    ledger.settle(RESERVE.anthropic, null);
    expect(ledger.reserved).toBe(0);
    expect(ledger.spent).toBe(RESERVE.anthropic);
  });

  it('deriveThoughts uses an explicit thoughts value or a positive usage gap', () => {
    expect(deriveThoughts(10, 5, 20, null)).toBe(5);
    expect(deriveThoughts(10, 5, 15, null)).toBeNull();
    expect(deriveThoughts(10, 5, 20, 7)).toBe(7);
  });

  it('estimates openai, anthropic, and xai amounts', () => {
    expect(estimateUsd('openai', 16, 5, 21, null)).toBe(0.0000054);
    expect(estimateUsd('anthropic', 21, 9, 30, null)).toBe(0.000198);
    expect(estimateUsd('xai', 1251, 13, 1847, null)).toBe(0.006078);
  });

  it('prices an alias call from the deployment that answered', () => {
    expect(reserveFor('auto')).toBe(RESERVE.xai);
    expect(priceCall('auto', 'xai', 1251, 13, 1847, null)).toBe(0.006078);
    expect(priceCall('auto', 'openai', 16, 5, 21, null)).toBe(0.0000054);
    expect(priceCall('auto', null, 1251, 13, 1847, null)).toBeNull();
  });

  it('reserves the judge output cap at the OpenAI rates', () => {
    expect(JUDGE_OUTPUT_TOKENS).toBe(256);
    expect(RESERVE.judge).toBeCloseTo(2000 * RATES.openai.input + JUDGE_OUTPUT_TOKENS * RATES.openai.output, 12);
  });

  it('rejectMaxUsd allows 2 and rejects 2.01 without the accept flag', () => {
    expect(rejectMaxUsd(2, false)).toBe(false);
    expect(rejectMaxUsd(2.01, false)).toBe(true);
    expect(rejectMaxUsd(2.01, true)).toBe(false);
  });
});

describe('perf quality', () => {
  it('objectivePass accepts exact json-ok and rejects duplicate ok keys', () => {
    const item = QUALITY_ITEMS.find((entry) => entry.id === 'json-ok');
    expect(item).toBeDefined();
    if (item === undefined) return;
    expect(objectivePass(item, '{"ok":true}')).toBe(true);
    expect(objectivePass(item, '  {"ok":true}  ')).toBe(true);
    expect(objectivePass(item, '{"ok":true,"ok":false}')).toBe(false);
    expect(objectivePass(item, '{"ok":false}')).toBe(false);
    expect(objectivePass(item, '')).toBe(false);
  });

  it('objectivePass uses code-point equality after trim', () => {
    const cafe = QUALITY_ITEMS.find((entry) => entry.id === 'cafe-newline');
    expect(cafe).toBeDefined();
    if (cafe === undefined) return;
    expect(cafe.task).toBe('Repeat the next line exactly.\ncafé');
    expect(objectivePass(cafe, 'café')).toBe(true);
    expect(objectivePass(cafe, 'cafe')).toBe(false);
  });

  it('parseJudgeResponse accepts a valid object and rejects tool_calls', () => {
    const criteria = Object.fromEntries(JUDGE_CRITERIA.map((id) => [id, 'X']));
    const valid = JSON.stringify({ winner: 'X', criteria, confidence: null });
    const parsed = parseJudgeResponse(valid, JUDGE_CRITERIA);
    expect(parsed.ok).toBe(true);

    const withTool = JSON.stringify({
      winner: 'Y',
      criteria: Object.fromEntries(JUDGE_CRITERIA.map((id) => [id, 'Y'])),
      tool_calls: [{ id: 'c1', type: 'function', function: { name: 'route', arguments: '{}' } }],
    });
    const rejected = parseJudgeResponse(withTool, JUDGE_CRITERIA);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.rejection).toBe('tool_invocation');
  });

  it('agreePair returns inconclusive on disagreement', () => {
    expect(agreePair('X', 'X')).toBe('inconclusive');
    expect(agreePair('X', 'Y')).toBe('anthropic');
    expect(agreePair('tie', 'tie')).toBe('tie');
    expect(agreePair('inconclusive', 'X')).toBe('inconclusive');
  });

  it('learningCurve keeps missing items in the denominator as false', () => {
    const curve = learningCurve([true, false], [true]);
    expect(curve).toEqual([
      { index: 1, passRate: 1, winRate: 1 },
      { index: 2, passRate: 0.5, winRate: 0.5 },
    ]);
  });

  it('judge static prompt omits provider names', () => {
    expect(judgePromptOmitsProviders([
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: 'TASK\n<<<\nok>>>\n' },
    ])).toBe(true);
    const messages = buildJudgeMessages('task text', 'ref', 'cand x', 'cand y');
    expect(judgePromptOmitsProviders(messages)).toBe(true);
    expect(/openai|anthropic|xai/i.test(JUDGE_SYSTEM_PROMPT)).toBe(false);
  });
});

describe('perf sample guard', () => {
  const models = ['openai', 'anthropic', 'xai'] as const;

  it('streams every live call when streaming capture is off', () => {
    for (const profile of ['smoke', 'scale'] as const) {
      const plan = buildPlan(profile, [...models]);
      expect(plan.some((call) => call.stream === false)).toBe(true);
      const guarded = applySampleGuard(plan, { streamingCapture: false });
      expect(guarded.safe).toBe(true);
      expect(guarded.reason).toBeNull();
      expect(guarded.calls.every((call) => call.stream === true)).toBe(true);
      expect(guarded.calls).toHaveLength(plan.length);
      expect(plan.filter((call) => call.kind === 'judge').length).toBeGreaterThan(0);
    }
    const oneSide = buildPlan('smoke', ['anthropic']);
    expect(oneSide.some((call) => call.kind === 'judge')).toBe(false);
  });

  it('refuses a live plan when streaming capture is on', () => {
    const plan = buildPlan('smoke', [...models]);
    const guarded = applySampleGuard(plan, { streamingCapture: true });
    expect(guarded.safe).toBe(false);
    expect(guarded.reason).toBe('streaming_capture');
  });
});

describe('perf telemetry', () => {
  it('rejects a tenant id that is not a uuid', () => {
    expect(enrichSql('not-a-uuid', ['11111111-1111-4111-8111-111111111111'])).toBeNull();
  });

  it('sums fallback cost and keeps the succeeded provider time', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    // Pipe fields follow telemetry COLUMNS order.
    const succeeded = [
      id, '2', 'succeeded', 'gpt-4o-mini', '100', '40', 'completed', '3', '20',
      '16', '5', '21', '', '0', '0', '16', '', '', '', 'end_turn', 'gpt-4o-mini',
      'estimated', 'estimated', '0.0000054', '110', '10', '12', 'low', 'true', '1',
      'general_qa', 'openai',
    ].join('|');
    const failed = [
      id, '1', 'failed', 'gpt-4o-mini', '20', '', '', '', '',
      '', '', '', '', '', '', '', 'client_error', 'client_error', 'client_error', '', '',
      '', 'estimated', '0.0000010', '', '', '', '', '', '', '', '',
    ].join('|');
    const parsed = parseEnrich(`${failed}\n${succeeded}\n`);
    const patch = parsed.get(id);
    expect(patch?.storedAmount).toBeCloseTo(0.0000064, 10);
    expect(patch?.serverDurationMs).toBe(120);
    expect(patch?.prompt).toBe(16);
    expect(patch?.serverTtftMs).toBe(40);
    expect(patch?.fallback).toBe(true);
    const primary = succeeded.split('|');
    primary[1] = '1';
    primary[18] = 'primary';
    const primaryPatch = parseEnrich(primary.join('|')).get(id);
    expect(primaryPatch?.fallback).toBe(false);
    primary[18] = 'upstream_error';
    expect(parseEnrich(primary.join('|')).get(id)?.fallback).toBe(true);
    expect(patch?.failureClass).toBe('client_error');
    expect(patch?.inputTokenEstimate).toBe(10);
    expect(patch?.selectedDeployment).toBe('openai');
    expect(foldRows([])).toBeNull();
  });
});

describe('perf analysis', () => {
  it('reports overhead, output speed, and a concurrency ratio', () => {
    const analysis = analyzeAttempts([
      {
        kind: 'load',
        model: 'openai',
        stream: true,
        done: true,
        error: null,
        concurrency: 1,
        wallMs: 1000,
        ttftMs: 400,
        serverDurationMs: 700,
        usage: { prompt: 16, completion: 6, total: 22 },
        amount: 0.00001,
        objectivePass: null,
      },
      {
        kind: 'load',
        model: 'openai',
        stream: true,
        done: true,
        error: null,
        concurrency: 8,
        wallMs: 2000,
        ttftMs: 500,
        serverDurationMs: 1500,
        usage: { prompt: 16, completion: 15, total: 31 },
        storedAmount: 0.00002,
        objectivePass: null,
      },
      {
        kind: 'quality',
        model: 'xai',
        error: null,
        wallMs: 1500,
        ttftMs: 1000,
        thoughts: 50,
        usage: { prompt: 100, completion: 10, total: 160 },
        amount: 0.002,
        objectivePass: false,
        itemId: 'word-yes',
      },
    ], [
      { model: 'openai', concurrency: 8, count: 8, ms: 2000 },
    ]);
    const openai = analysis.models.find((model) => model.model === 'openai');
    expect(openai?.overhead.n).toBe(2);
    expect(openai?.outputPerSecond.p50).toBeGreaterThan(0);
    const ratio = analysis.concurrency.find((point) => point.model === 'openai' && point.concurrency === 8);
    expect(ratio?.ratioToOne).toBe(2);
    expect(ratio?.callsPerSecond).toBe(4);
    expect(analysis.thoughtsShare).toBeCloseTo(50 / 160, 6);
    expect(analysis.totalCost).toBeCloseTo(0.00203, 8);
    expect(analysis.findings.some((line) => line.includes('word-yes'))).toBe(false);
    expect(numStat([10, 20, 30, 40]).p95).toBe(40);
  });

  it('counts a stable judge win and compares a previous run', () => {
    const analysis = analyzeAttempts([
      { kind: 'judge', model: 'openai', itemId: 'json-ok', judgeOrder: 'forward', judgeVote: 'X', error: null },
      { kind: 'judge', model: 'openai', itemId: 'json-ok', judgeOrder: 'reverse', judgeVote: 'Y', error: null },
    ]);
    expect(analysis.judgeWins).toBe(1);
    expect(analysis.judgeLabeled).toBe(1);
    const unlabeled = analyzeAttempts([
      { kind: 'judge', model: 'openai', itemId: 'json-ok', judgeOrder: 'forward', judgeVote: null, error: null },
      { kind: 'judge', model: 'openai', itemId: 'json-ok', judgeOrder: 'reverse', judgeVote: null, error: null },
    ]);
    expect(unlabeled.judgeLabeled).toBe(1);
    expect(unlabeled.judgeInconclusive).toBe(1);
    const omitted = analyzeAttempts([
      { kind: 'judge', model: 'openai', itemId: 'json-ok', judgeOrder: 'forward', error: null },
      { kind: 'judge', model: 'openai', itemId: 'json-ok', judgeOrder: 'reverse', error: null },
    ]);
    expect(omitted.judgeLabeled).toBe(0);
    expect(omitted.findings.some((line) => line.includes('not saved'))).toBe(true);
    const lines = compareHistory(
      { wallP50: 1000, spend: 0.01, errorRate: 0 },
      { wallP50: 1100, spend: 0.02, errorRate: 0.1 },
    );
    expect(lines[0]).toContain('100.000 ms');
    expect(compareHistory(null, { wallP50: 1, spend: 0, errorRate: 0 })[0]).toContain('No earlier run');
  });
});

describe('perf svg', () => {
  it('returns an svg element that includes the title', () => {
    const svg = lineChart({
      title: 'Latency by concurrency',
      xLabel: 'concurrency',
      yLabel: 'ms',
      series: [
        { name: 'openai', color: '#1f77b4', points: [{ x: 1, y: 10 }, { x: 4, y: 20 }] },
      ],
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('Latency by concurrency');
    const bars = barChart({
      title: 'Cost by model',
      yLabel: 'USD',
      bars: [{ name: 'openai', value: 0.01, color: '#1f77b4' }],
    });
    expect(bars).toContain('<svg');
    expect(bars).toContain('Cost by model');
    expect(bars).toContain('height="300.00"');
    expect(bars).toContain('0.0100');
  });
});
