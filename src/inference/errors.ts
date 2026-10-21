import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { networkFailureKind } from './execution-policy.js';

export type OpenAiErrorBody = {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
};

export type FailedAttemptFacts = {
  providerRequestId: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  thoughtsTokens: number | null;
};

export function emptyAttemptFacts(): FailedAttemptFacts {
  return {
    providerRequestId: null,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
  };
}

export type DeadlineKindName = 'connection' | 'attempt' | 'total';

export type ErrorTransport = {
  upstreamStatus: number | null;
  retryAfter: string | null;
  deadlineKind: DeadlineKindName | null;
  connectionFailure: boolean;
  ambiguousNetwork: boolean;
};

export function emptyTransport(): ErrorTransport {
  return {
    upstreamStatus: null,
    retryAfter: null,
    deadlineKind: null,
    connectionFailure: false,
    ambiguousNetwork: false,
  };
}

export function readRetryAfter(headers: unknown): string | null {
  if (headers === null || headers === undefined || typeof headers !== 'object') return null;
  if ('get' in headers && typeof headers.get === 'function') {
    const value = headers.get.call(headers, 'retry-after');
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  const record = headers as Record<string, unknown>;
  const raw = record['retry-after'] ?? record['Retry-After'];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function transportFor(error: unknown, upstreamStatus: number | null, retryAfter: string | null): ErrorTransport {
  const kind = networkFailureKind(error);
  return {
    upstreamStatus,
    retryAfter,
    deadlineKind: null,
    connectionFailure: kind === 'connection',
    ambiguousNetwork: kind === 'ambiguous',
  };
}

export class ProxyError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly param: string | null;
  readonly code: string | null;

  readonly nativeReason: string | null;
  readonly attempt: FailedAttemptFacts;
  readonly transport: ErrorTransport;

  constructor(
    status: number,
    errorType: string,
    code: string | null,
    param: string | null,
    message: string,
    nativeReason: string | null = null,
    attempt: FailedAttemptFacts = emptyAttemptFacts(),
    transport: ErrorTransport = emptyTransport(),
  ) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.errorType = errorType;
    this.code = code;
    this.param = param;
    this.nativeReason = nativeReason;
    this.attempt = attempt;
    this.transport = transport;
  }

  body(): OpenAiErrorBody {
    return {
      error: {
        message: this.message,
        type: this.errorType,
        param: this.param,
        code: this.code,
      },
    };
  }
}

export function proxyError(
  status: number,
  errorType: string,
  code: string | null,
  param: string | null,
  message: string,
  nativeReason: string | null = null,
  attempt?: FailedAttemptFacts,
  transport?: ErrorTransport,
): ProxyError {
  return new ProxyError(
    status,
    errorType,
    code,
    param,
    message,
    nativeReason,
    attempt ?? emptyAttemptFacts(),
    transport ?? emptyTransport(),
  );
}

export function timeoutProxy(kind: DeadlineKindName | null): ProxyError {
  return proxyError(504, 'server_error', 'timeout', null, 'The upstream model request timed out.', 'timeout', emptyAttemptFacts(), {
    ...emptyTransport(),
    deadlineKind: kind,
  });
}

export function safeNativeReason(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[a-z0-9_]{1,64}$/.test(value)) return null;
  return value;
}

export function safeProviderRequestId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /\s/.test(value)) return null;
  return value;
}

export function invalidRequest(param: string, code: string, message: string): ProxyError {
  return proxyError(400, 'invalid_request_error', code, param, message);
}

export function normalizeUpstreamError(error: unknown, callerAborted: boolean): ProxyError {
  if (callerAborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
  }
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
    return timeoutProxy(null);
  }
  if (error instanceof APIError) {
    const transport = transportFor(error, typeof error.status === 'number' ? error.status : null, readRetryAfter(error.headers));
    if (error.status === 429) {
      return proxyError(429, 'rate_limit_error', 'rate_limit', null, 'The upstream model request failed.', null, emptyAttemptFacts(), transport);
    }
    return proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.', null, emptyAttemptFacts(), transport);
  }
  if (error instanceof ProxyError) return error;
  return proxyError(
    502,
    'server_error',
    'upstream_error',
    null,
    'The upstream model request failed.',
    null,
    emptyAttemptFacts(),
    transportFor(error, null, null),
  );
}

export function safeErrorCode(code: string | null): string {
  if (code !== null && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  return 'upstream_error';
}
