export const EXECUTION_POLICY_VERSION = 1;

export type DeadlineKind = 'connection' | 'attempt' | 'total';

export type ExpenseCertainty = 'none' | 'uncertain' | 'known';

export type FailureClass =
  | 'cancelled'
  | 'stream_started'
  | 'total_deadline'
  | 'timeout_before_dispatch'
  | 'timeout_after_dispatch'
  | 'ambiguous_network'
  | 'client_error'
  | 'unauthorized'
  | 'connection_failure'
  | 'rate_limit'
  | 'unavailable'
  | 'upstream_error';

export type PolicyInput = {
  version: number;
  retriesEnabled: boolean;
  maxAttempts: number;
  connectionDeadlineMs: number;
  attemptDeadlineMs: number;
  totalDeadlineMs: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
};

export type StoredExecutionPolicy = PolicyInput & {
  id: string;
};

export type FailureInput = {
  callerAborted: boolean;
  outputStarted: boolean;
  dispatched: boolean;
  timedOut: boolean;
  deadlineKind: DeadlineKind | null;
  httpStatus: number | null;
  retryAfter: string | null;
  connectionFailure: boolean;
  ambiguousNetwork: boolean;
};

export type RetryDecision = {
  failureClass: FailureClass;
  retry: boolean;
  waitMs: number;
  expenseCertainty: ExpenseCertainty;
  stopReason:
    | 'caller_cancelled'
    | 'output_started'
    | 'deadline'
    | 'not_retryable'
    | 'attempt_limit'
    | 'retries_disabled'
    | 'retry_after'
    | 'wait';
};

const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH']);
const AMBIGUOUS_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

export class ExecutionDeadlineError extends Error {
  readonly kind: DeadlineKind;

  constructor(kind: DeadlineKind) {
    super(`execution_${kind}_deadline`);
    this.name = 'ExecutionDeadlineError';
    this.kind = kind;
  }
}

export function defaultPolicy(timeoutMs: number): PolicyInput {
  return {
    version: EXECUTION_POLICY_VERSION,
    retriesEnabled: false,
    maxAttempts: 1,
    connectionDeadlineMs: timeoutMs,
    attemptDeadlineMs: timeoutMs,
    totalDeadlineMs: timeoutMs,
    initialBackoffMs: 0,
    maxBackoffMs: 0,
  };
}

export function policyAttempts(policy: PolicyInput): number {
  if (!policy.retriesEnabled) return 1;
  const stored = Number.isInteger(policy.maxAttempts) ? policy.maxAttempts : 1;
  if (stored < 1) return 1;
  if (stored > 2) return 2;
  return stored;
}

export function isCallerAbort(signal: AbortSignal | undefined): boolean {
  if (signal === undefined || !signal.aborted) return false;
  return !(signal.reason instanceof ExecutionDeadlineError);
}

export function deadlineKindOf(signal: AbortSignal | undefined): DeadlineKind | null {
  if (signal === undefined || !signal.aborted) return null;
  return signal.reason instanceof ExecutionDeadlineError ? signal.reason.kind : null;
}

export function networkFailureKind(error: unknown): 'connection' | 'ambiguous' | null {
  const codes = collectCodes(error, new Set());
  if (codes.some((code) => PRE_SEND_CODES.has(code))) return 'connection';
  if (codes.some((code) => AMBIGUOUS_CODES.has(code))) return 'ambiguous';
  return null;
}

function collectCodes(error: unknown, seen: Set<unknown>): string[] {
  if (error === null || typeof error !== 'object' || seen.has(error)) return [];
  seen.add(error);
  const codes: string[] = [];
  if ('code' in error && typeof error.code === 'string') codes.push(error.code);
  if ('cause' in error) codes.push(...collectCodes(error.cause, seen));
  if ('errors' in error && Array.isArray(error.errors)) {
    for (const item of error.errors) codes.push(...collectCodes(item, seen));
  }
  return codes;
}

export function armDeadline(
  kind: DeadlineKind,
  ms: number,
  parent: AbortSignal | null,
): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort(new ExecutionDeadlineError(kind));
  }, ms);
  let stopParent = (): void => undefined;
  if (parent !== null) {
    const onParent = (): void => {
      if (!controller.signal.aborted) controller.abort(parent.reason);
    };
    if (parent.aborted) onParent();
    else {
      parent.addEventListener('abort', onParent, { once: true });
      stopParent = () => parent.removeEventListener('abort', onParent);
    }
  }
  return {
    signal: controller.signal,
    cancel(): void {
      clearTimeout(timer);
      stopParent();
    },
  };
}

export function linkAbortSignals(signals: readonly AbortSignal[]): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const stops: Array<() => void> = [];
  for (const signal of signals) {
    const onAbort = (): void => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      break;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    stops.push(() => signal.removeEventListener('abort', onAbort));
  }
  return {
    signal: controller.signal,
    cancel(): void {
      for (const stop of stops) stop();
    },
  };
}

export function startTotalDeadline(enabled: boolean, ms: number): { signal: AbortSignal | null; cancel: () => void } {
  if (!enabled) return { signal: null, cancel(): void {} };
  const total = armDeadline('total', ms, null);
  return { signal: total.signal, cancel: total.cancel };
}

export function startAttemptDeadlines(input: {
  enabled: boolean;
  caller: AbortSignal;
  total: AbortSignal | null;
  connectionMs: number;
  attemptMs: number;
}): { signal: AbortSignal; cancel: () => void; noteHeaders: () => void } {
  if (!input.enabled) {
    return {
      signal: input.caller,
      cancel(): void {},
      noteHeaders(): void {},
    };
  }
  const connection = armDeadline('connection', input.connectionMs, null);
  const attempt = armDeadline('attempt', input.attemptMs, null);
  const signals = [input.caller, attempt.signal, connection.signal];
  if (input.total !== null) signals.push(input.total);
  const linked = linkAbortSignals(signals);
  return {
    signal: linked.signal,
    cancel(): void {
      connection.cancel();
      attempt.cancel();
      linked.cancel();
    },
    noteHeaders(): void {
      connection.cancel();
    },
  };
}

export type AttemptTrace = {
  fetchEntered: boolean;
  headersReceived: boolean;
  retryAfter: string | null;
};

export function emptyAttemptTrace(): AttemptTrace {
  return { fetchEntered: false, headersReceived: false, retryAfter: null };
}

export function traceFetch(
  base: typeof fetch | undefined,
  trace: AttemptTrace | undefined,
  onHeaders?: () => void,
): typeof fetch {
  const impl = base ?? fetch;
  return async (input, init) => {
    if (trace !== undefined) trace.fetchEntered = true;
    const response = await impl(input, init);
    if (trace !== undefined) {
      trace.headersReceived = true;
      const header = response.headers.get('retry-after');
      if (typeof header === 'string' && header.trim().length > 0) trace.retryAfter = header.trim();
    }
    onHeaders?.();
    return response;
  };
}

// The injected fetch serves xAI, OpenRouter, and DGX. The other providers keep the platform fetch.
export function fetchForProvider(
  provider: string,
  transportFetch: typeof fetch | undefined,
  trace: AttemptTrace,
  onHeaders: () => void,
): typeof fetch {
  if (provider === 'xai' || provider === 'openrouter' || provider === 'dgx') {
    return traceFetch(transportFetch, trace, onHeaders);
  }
  return traceFetch(undefined, trace, onHeaders);
}

export function waitForRetry(ms: number, signals: readonly AbortSignal[]): Promise<'ok' | 'aborted'> {
  if (signals.some((signal) => signal.aborted)) return Promise.resolve('aborted');
  if (ms <= 0) return Promise.resolve('ok');
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish('ok'), ms);
    const onAbort = (): void => finish('aborted');
    function finish(result: 'ok' | 'aborted'): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', onAbort);
      resolve(result);
    }
    for (const signal of signals) signal.addEventListener('abort', onAbort);
  });
}

type Classified = {
  failureClass: FailureClass;
  expenseCertainty: ExpenseCertainty;
  retryable: boolean;
  stopReason: RetryDecision['stopReason'];
};

function classify(failure: FailureInput, elapsedMs: number, policy: PolicyInput, deadlinesActive: boolean): Classified {
  if (failure.callerAborted) {
    return {
      failureClass: 'cancelled',
      expenseCertainty: failure.dispatched ? 'uncertain' : 'none',
      retryable: false,
      stopReason: 'caller_cancelled',
    };
  }
  if (failure.outputStarted) {
    return {
      failureClass: 'stream_started',
      expenseCertainty: failure.dispatched ? 'uncertain' : 'none',
      retryable: false,
      stopReason: 'output_started',
    };
  }
  if (failure.deadlineKind === 'total' || (deadlinesActive && elapsedMs >= policy.totalDeadlineMs)) {
    return {
      failureClass: 'total_deadline',
      expenseCertainty: failure.dispatched ? 'uncertain' : 'none',
      retryable: false,
      stopReason: 'deadline',
    };
  }
  const timedOut = failure.timedOut || failure.deadlineKind === 'connection' || failure.deadlineKind === 'attempt';
  if (timedOut && !failure.dispatched) {
    return {
      failureClass: 'timeout_before_dispatch',
      expenseCertainty: 'none',
      retryable: false,
      stopReason: 'deadline',
    };
  }
  if (timedOut && failure.dispatched) {
    return {
      failureClass: 'timeout_after_dispatch',
      expenseCertainty: 'uncertain',
      retryable: false,
      stopReason: 'deadline',
    };
  }
  if (failure.ambiguousNetwork && failure.dispatched) {
    return {
      failureClass: 'ambiguous_network',
      expenseCertainty: 'uncertain',
      retryable: false,
      stopReason: 'not_retryable',
    };
  }
  if (failure.httpStatus === 400 || (failure.httpStatus !== null && failure.httpStatus >= 400 && failure.httpStatus < 500 && failure.httpStatus !== 401 && failure.httpStatus !== 403 && failure.httpStatus !== 429)) {
    return {
      failureClass: 'client_error',
      expenseCertainty: 'known',
      retryable: false,
      stopReason: 'not_retryable',
    };
  }
  if (failure.httpStatus === 401 || failure.httpStatus === 403) {
    return {
      failureClass: 'unauthorized',
      expenseCertainty: 'known',
      retryable: false,
      stopReason: 'not_retryable',
    };
  }
  if (failure.connectionFailure && !failure.dispatched) {
    return {
      failureClass: 'connection_failure',
      expenseCertainty: 'none',
      retryable: true,
      stopReason: 'wait',
    };
  }
  if (failure.httpStatus === 429) {
    return {
      failureClass: 'rate_limit',
      expenseCertainty: 'known',
      retryable: true,
      stopReason: 'wait',
    };
  }
  if (failure.httpStatus === 503) {
    return {
      failureClass: 'unavailable',
      expenseCertainty: 'known',
      retryable: true,
      stopReason: 'wait',
    };
  }
  if (failure.httpStatus !== null) {
    return {
      failureClass: 'upstream_error',
      expenseCertainty: 'known',
      retryable: false,
      stopReason: 'not_retryable',
    };
  }
  return {
    failureClass: 'upstream_error',
    expenseCertainty: failure.dispatched ? 'uncertain' : 'none',
    retryable: false,
    stopReason: 'not_retryable',
  };
}

function parseRetryAfter(header: string | null, nowMs: number): { valid: true; waitMs: number } | { valid: false } {
  if (header === null) return { valid: false };
  const text = header.trim();
  if (text.length === 0) return { valid: false };
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    if (!Number.isSafeInteger(seconds)) return { valid: false };
    return { valid: true, waitMs: seconds * 1000 };
  }
  const parsed = Date.parse(text);
  if (Number.isNaN(parsed)) return { valid: false };
  const wait = parsed - nowMs;
  return { valid: true, waitMs: wait <= 0 ? 0 : wait };
}

function waitFits(waitMs: number, remainingMs: number, policy: PolicyInput): boolean {
  return (
    waitMs >= 0 &&
    waitMs < remainingMs &&
    waitMs <= policy.connectionDeadlineMs &&
    waitMs <= policy.attemptDeadlineMs &&
    waitMs <= policy.totalDeadlineMs
  );
}

function jitteredBackoff(policy: PolicyInput, ordinal: number, random: () => number, remainingMs: number): number {
  const shift = Math.max(0, ordinal - 1);
  const raw = policy.initialBackoffMs * 2 ** shift;
  const cap = Math.min(
    raw,
    policy.maxBackoffMs,
    remainingMs,
    policy.connectionDeadlineMs,
    policy.attemptDeadlineMs,
    policy.totalDeadlineMs,
  );
  if (cap <= 0) return 0;
  const rolled = random();
  const unit = rolled <= 0 ? 0 : rolled >= 1 ? 0.999999 : rolled;
  return Math.floor(unit * cap);
}

export function decideRetry(input: {
  policy: PolicyInput;
  deadlinesActive: boolean;
  ordinal: number;
  elapsedMs: number;
  nowMs: number;
  random: () => number;
  failure: FailureInput;
}): RetryDecision {
  const classified = classify(input.failure, input.elapsedMs, input.policy, input.deadlinesActive);
  const limit = policyAttempts(input.policy);
  if (!classified.retryable || !input.policy.retriesEnabled || input.ordinal >= limit) {
    const stopReason = input.failure.callerAborted
      ? 'caller_cancelled'
      : input.failure.outputStarted
        ? 'output_started'
        : !classified.retryable
          ? classified.stopReason
          : !input.policy.retriesEnabled
            ? 'retries_disabled'
            : 'attempt_limit';
    return {
      failureClass: classified.failureClass,
      retry: false,
      waitMs: 0,
      expenseCertainty: classified.expenseCertainty,
      stopReason,
    };
  }
  const remaining = input.policy.totalDeadlineMs - input.elapsedMs;
  if (remaining <= 0) {
    return {
      failureClass: classified.failureClass,
      retry: false,
      waitMs: 0,
      expenseCertainty: classified.expenseCertainty,
      stopReason: 'deadline',
    };
  }
  const retryAfter = parseRetryAfter(input.failure.retryAfter, input.nowMs);
  if (retryAfter.valid) {
    if (!waitFits(retryAfter.waitMs, remaining, input.policy)) {
      return {
        failureClass: classified.failureClass,
        retry: false,
        waitMs: 0,
        expenseCertainty: classified.expenseCertainty,
        stopReason: 'retry_after',
      };
    }
    return {
      failureClass: classified.failureClass,
      retry: true,
      waitMs: retryAfter.waitMs,
      expenseCertainty: classified.expenseCertainty,
      stopReason: 'wait',
    };
  }
  const waitMs = jitteredBackoff(input.policy, input.ordinal, input.random, remaining);
  if (!waitFits(waitMs, remaining, input.policy) && waitMs !== 0) {
    return {
      failureClass: classified.failureClass,
      retry: false,
      waitMs: 0,
      expenseCertainty: classified.expenseCertainty,
      stopReason: 'deadline',
    };
  }
  if (waitMs >= remaining) {
    return {
      failureClass: classified.failureClass,
      retry: false,
      waitMs: 0,
      expenseCertainty: classified.expenseCertainty,
      stopReason: 'deadline',
    };
  }
  return {
    failureClass: classified.failureClass,
    retry: true,
    waitMs,
    expenseCertainty: classified.expenseCertainty,
    stopReason: 'wait',
  };
}

export function wasDispatched(input: {
  fetchEntered: boolean;
  headersReceived: boolean;
  httpStatus: number | null;
  connectionFailure: boolean;
  ambiguousNetwork: boolean;
  timedOut: boolean;
  deadlineKind: DeadlineKind | null;
}): boolean {
  if (input.headersReceived || input.httpStatus !== null) return true;
  if (input.connectionFailure) return false;
  if (input.deadlineKind === 'connection') return false;
  if (!input.fetchEntered) return false;
  if (input.ambiguousNetwork || input.timedOut || input.deadlineKind === 'attempt' || input.deadlineKind === 'total') {
    return true;
  }
  return false;
}
