import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import {
  EXECUTION_POLICY_VERSION,
  decideRetry,
  defaultPolicy,
  policyAttempts,
  waitForRetry,
  type FailureInput,
  type PolicyInput,
} from '../src/inference/execution-policy.js';
import { projectRoot } from './helpers.js';

function policy(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    version: EXECUTION_POLICY_VERSION,
    retriesEnabled: true,
    maxAttempts: 2,
    connectionDeadlineMs: 5_000,
    attemptDeadlineMs: 5_000,
    totalDeadlineMs: 5_000,
    initialBackoffMs: 100,
    maxBackoffMs: 1_000,
    ...overrides,
  };
}

function failure(overrides: Partial<FailureInput> = {}): FailureInput {
  return {
    callerAborted: false,
    outputStarted: false,
    dispatched: false,
    timedOut: false,
    deadlineKind: null,
    httpStatus: null,
    retryAfter: null,
    connectionFailure: false,
    ambiguousNetwork: false,
    ...overrides,
  };
}

function decide(input: {
  policy?: PolicyInput;
  deadlinesActive?: boolean;
  ordinal?: number;
  elapsedMs?: number;
  nowMs?: number;
  random?: () => number;
  failure?: FailureInput;
}) {
  return decideRetry({
    policy: input.policy ?? policy(),
    deadlinesActive: input.deadlinesActive ?? true,
    ordinal: input.ordinal ?? 1,
    elapsedMs: input.elapsedMs ?? 0,
    nowMs: input.nowMs ?? 0,
    random: input.random ?? (() => 0),
    failure: input.failure ?? failure({ httpStatus: 429, dispatched: true }),
  });
}

describe('execution policy decisions', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the policy version at 1 and clamps an enabled retry to two attempts', () => {
    expect(EXECUTION_POLICY_VERSION).toBe(1);
    expect(policyAttempts(policy({ maxAttempts: 9 }))).toBe(2);
    expect(policyAttempts(policy({ retriesEnabled: false, maxAttempts: 2 }))).toBe(1);
    expect(defaultPolicy(1_000).retriesEnabled).toBe(false);
    expect(policyAttempts(defaultPolicy(1_000))).toBe(1);
  });

  it('keeps jitter inside the remaining deadline', () => {
    const decision = decide({
      policy: policy({
        initialBackoffMs: 1_000,
        maxBackoffMs: 1_000,
        connectionDeadlineMs: 50,
        attemptDeadlineMs: 80,
        totalDeadlineMs: 1_000,
      }),
      elapsedMs: 900,
      random: () => 0.99,
    });
    expect(decision.retry).toBe(true);
    expect(decision.waitMs).toBe(49);
    expect(decision.waitMs).toBeLessThan(100);
    expect(decision.waitMs).toBeLessThanOrEqual(50);
    expect(decision.failureClass).toBe('rate_limit');
    console.log(`RETRY_CLOCK ${JSON.stringify({ case: 'jitter-cap', waitMs: decision.waitMs, retry: decision.retry })}`);
  });

  it('does not let a random value of 1 reach the cap', () => {
    const decision = decide({
      policy: policy({ initialBackoffMs: 100, maxBackoffMs: 100, connectionDeadlineMs: 5_000 }),
      random: () => 1,
    });
    expect(decision.retry).toBe(true);
    expect(decision.waitMs).toBe(99);
    expect(decision.waitMs).toBeLessThan(100);
  });

  it('uses bounded backoff when Retry-After is not a delay', () => {
    const decision = decide({
      policy: policy({ initialBackoffMs: 40, maxBackoffMs: 40 }),
      random: () => 0.5,
      failure: failure({ httpStatus: 429, dispatched: true, retryAfter: 'soon' }),
    });
    expect(decision.retry).toBe(true);
    expect(decision.waitMs).toBe(20);
    expect(decision.stopReason).toBe('wait');
    console.log(`RETRY_CLOCK ${JSON.stringify({ case: 'invalid-retry-after', waitMs: decision.waitMs })}`);
  });

  it('honors a valid Retry-After only when the wait fits', () => {
    const fits = decide({
      policy: policy({ totalDeadlineMs: 5_000, connectionDeadlineMs: 5_000, attemptDeadlineMs: 5_000 }),
      elapsedMs: 100,
      failure: failure({ httpStatus: 503, dispatched: true, retryAfter: '2' }),
    });
    expect(fits.retry).toBe(true);
    expect(fits.waitMs).toBe(2_000);
    expect(fits.failureClass).toBe('unavailable');

    const header = new Date(1_700_000_000_000 + 2_000).toUTCString();
    const dated = decide({
      nowMs: 1_700_000_000_000,
      elapsedMs: 0,
      failure: failure({ httpStatus: 429, dispatched: true, retryAfter: header }),
    });
    expect(dated.retry).toBe(true);
    expect(dated.waitMs).toBe(2_000);

    const past = decide({
      nowMs: 1_700_000_000_000,
      failure: failure({
        httpStatus: 429,
        dispatched: true,
        retryAfter: new Date(1_700_000_000_000 - 5_000).toUTCString(),
      }),
    });
    expect(past.retry).toBe(true);
    expect(past.waitMs).toBe(0);

    const tight = decide({
      policy: policy({ totalDeadlineMs: 2_000 }),
      elapsedMs: 0,
      failure: failure({ httpStatus: 429, dispatched: true, retryAfter: '2' }),
    });
    expect(tight.retry).toBe(false);
    expect(tight.waitMs).toBe(0);
    expect(tight.stopReason).toBe('retry_after');
    expect(tight.failureClass).toBe('rate_limit');
    console.log(
      `RETRY_CLOCK ${JSON.stringify({
        case: 'retry-after',
        deltaSeconds: fits.waitMs,
        httpDate: dated.waitMs,
        equalRemainingStops: tight.retry,
      })}`,
    );
  });

  it('stops without another attempt for cancellation, output, client errors, and deadlines', () => {
    const cases = [
      { name: 'caller', failure: failure({ callerAborted: true }), failureClass: 'cancelled' },
      { name: 'output', failure: failure({ outputStarted: true, dispatched: true }), failureClass: 'stream_started' },
      { name: 'http-400', failure: failure({ httpStatus: 400, dispatched: true }), failureClass: 'client_error' },
      { name: 'http-401', failure: failure({ httpStatus: 401, dispatched: true }), failureClass: 'unauthorized' },
      { name: 'before', failure: failure({ timedOut: true, deadlineKind: 'connection' }), failureClass: 'timeout_before_dispatch' },
      {
        name: 'after',
        failure: failure({ timedOut: true, deadlineKind: 'attempt', dispatched: true }),
        failureClass: 'timeout_after_dispatch',
      },
      {
        name: 'ambiguous',
        failure: failure({ ambiguousNetwork: true, dispatched: true }),
        failureClass: 'ambiguous_network',
      },
    ];
    for (const item of cases) {
      const decision = decide({ failure: item.failure });
      expect(decision.retry).toBe(false);
      expect(decision.waitMs).toBe(0);
      expect(decision.failureClass).toBe(item.failureClass);
    }
    const total = decide({
      elapsedMs: 1_000,
      policy: policy({ totalDeadlineMs: 1_000 }),
      failure: failure({ httpStatus: 429, dispatched: true }),
    });
    expect(total.retry).toBe(false);
    expect(total.failureClass).toBe('total_deadline');
    const limit = decide({ ordinal: 2 });
    expect(limit.retry).toBe(false);
    expect(limit.stopReason).toBe('attempt_limit');
    const disabled = decide({
      policy: defaultPolicy(1_000),
      deadlinesActive: false,
      elapsedMs: 5_000,
    });
    expect(disabled.retry).toBe(false);
    expect(disabled.stopReason).toBe('retries_disabled');
    expect(disabled.failureClass).toBe('rate_limit');
    console.log(
      `RETRY_CLOCK ${JSON.stringify({
        case: 'stops',
        classes: cases.map((item) => item.failureClass),
        total: total.failureClass,
        limit: limit.stopReason,
        disabled: disabled.stopReason,
      })}`,
    );
  });

  it('retries a connection failure that has not been dispatched', () => {
    const decision = decide({
      failure: failure({ connectionFailure: true, dispatched: false }),
    });
    expect(decision.retry).toBe(true);
    expect(decision.failureClass).toBe('connection_failure');
    expect(decision.expenseCertainty).toBe('none');
    const after = decide({
      failure: failure({ timedOut: true, deadlineKind: 'attempt', dispatched: true }),
    });
    expect(after.expenseCertainty).toBe('uncertain');
    expect(after.retry).toBe(false);
  });

  it('aborts a backoff wait when the caller signal aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pending = waitForRetry(5_000, [controller.signal]);
    controller.abort();
    await expect(pending).resolves.toBe('aborted');
    const quiet = waitForRetry(1_000, []);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(quiet).resolves.toBe('ok');
  });

  it('keeps provider SDK retries off in the shipped clients', () => {
    const adapter = readFileSync(join(projectRoot, 'src/inference/adapter.ts'), 'utf8');
    const anthropic = readFileSync(join(projectRoot, 'src/inference/anthropic.ts'), 'utf8');
    expect(adapter).toContain('maxRetries: 0');
    expect(anthropic).toContain('maxRetries: 0');
    expect(adapter).not.toMatch(/maxRetries:\s*[1-9]/);
    expect(anthropic).not.toMatch(/maxRetries:\s*[1-9]/);
  });
});
