import { describe, expect, it } from 'vitest';
import { ProxyError } from '../src/inference/errors.js';
import {
  parseScheduleWrite,
  SCHEDULE_CHALLENGER_CALL_CEILING,
  SCHEDULE_DAILY_CEILING,
  SCHEDULE_SAMPLE_CEILING,
} from '../src/inference/evaluation-schedule.js';

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: false,
    dailyLimit: SCHEDULE_DAILY_CEILING,
    monthlyLimit: SCHEDULE_DAILY_CEILING,
    perRunMaxExpense: '0.73',
    maxChallengerCalls: SCHEDULE_CHALLENGER_CALL_CEILING,
    maxJudgeCalls: 0,
    maxConcurrentJobs: 1,
    maxDurationMs: 60_000,
    maxSamples: SCHEDULE_SAMPLE_CEILING,
    challengerDeployment: 'openai',
    sampleCategory: 'general_qa',
    ...overrides,
  };
}

describe('evaluation schedule ceilings', () => {
  it('accepts one qualifying cohort at the daily, sample, and call ceilings', () => {
    const parsed = parseScheduleWrite(body());
    expect(parsed.dailyLimit).toBe('2.92');
    expect(parsed.monthlyLimit).toBe('2.92');
    expect(parsed.perRunMaxExpense).toBe('0.73');
    expect(parsed.maxSamples).toBe(73);
    expect(parsed.maxChallengerCalls).toBe(292);
    expect(parsed.maxJudgeCalls).toBe(0);
  });

  it('rejects a daily limit above 2.92 when the monthly limit is still inside 20', () => {
    let caught: unknown;
    try {
      parseScheduleWrite(body({ dailyLimit: '2.93', monthlyLimit: '20' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ProxyError);
    expect((caught as ProxyError).param).toBe('daily_limit');
  });

  it('rejects a sample count, a challenger call count, or a judge call count above the ceiling', () => {
    for (const overrides of [{ maxSamples: 74 }, { maxChallengerCalls: 293 }, { maxJudgeCalls: 41 }]) {
      let caught: unknown;
      try {
        parseScheduleWrite(body(overrides));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ProxyError);
      expect((caught as ProxyError).param).toBe('limits');
    }
  });
});
