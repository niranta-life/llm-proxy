import { proxyError, type ProxyError } from './errors.js';

export type BreakerStateName = 'closed' | 'open' | 'half_open';

export type BreakerOutcome = 'success' | 'failure' | 'rate_limit' | 'ignore';

export type BreakerAdmission = 'skip' | 'allow' | 'reject' | 'claim';

export type BreakerTransition = 'record' | 'open' | 'close' | 'reopen' | 'release';

const HEALTH_FAILURES = new Set([
  'timeout_before_dispatch',
  'timeout_after_dispatch',
  'total_deadline',
  'connection_failure',
  'unavailable',
  'upstream_error',
]);

export type BreakerView = {
  enabled: boolean;
  state: BreakerStateName;
  cooldownUntilMs: number | null;
  probesInflight: number;
  maxProbes: number;
};

export function circuitOpenError(): ProxyError {
  return proxyError(503, 'server_error', 'circuit_open', null, 'The deployment is unavailable.');
}

export function classifyBreakerOutcome(input: {
  succeeded: boolean;
  callerAborted: boolean;
  failureClass: string | null;
}): BreakerOutcome {
  if (input.succeeded) return 'success';
  if (input.callerAborted || input.failureClass === 'cancelled' || input.failureClass === 'stream_started') return 'ignore';
  if (input.failureClass === 'rate_limit') return 'rate_limit';
  if (input.failureClass !== null && HEALTH_FAILURES.has(input.failureClass)) return 'failure';
  return 'ignore';
}

export function decideAdmission(snapshot: BreakerView | null, nowMs: number): BreakerAdmission {
  if (snapshot === null || !snapshot.enabled) return 'skip';
  if (snapshot.state === 'closed') return 'allow';
  const cooling = snapshot.cooldownUntilMs !== null && snapshot.cooldownUntilMs > nowMs;
  if (snapshot.state === 'open' && cooling) return 'reject';
  if (snapshot.probesInflight >= snapshot.maxProbes) return 'reject';
  return 'claim';
}

export function decideTransition(input: {
  state: BreakerStateName;
  probe: boolean;
  kind: BreakerOutcome;
  samples: number;
  failures: number;
  minSamples: number;
  failureThreshold: number;
}): BreakerTransition {
  if (input.kind === 'ignore') return input.probe ? 'release' : 'record';
  if (input.kind === 'rate_limit') return input.probe ? 'release' : 'record';
  if (input.probe && input.kind === 'success' && input.state === 'half_open') return 'close';
  if (input.probe && input.kind === 'failure' && input.state === 'half_open') return 'reopen';
  if (
    input.kind === 'failure' &&
    input.state === 'closed' &&
    input.samples >= input.minSamples &&
    input.failures >= input.failureThreshold
  ) {
    return 'open';
  }
  return 'record';
}
