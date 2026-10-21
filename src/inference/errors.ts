import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

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

export class ProxyError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly param: string | null;
  readonly code: string | null;

  readonly nativeReason: string | null;
  readonly attempt: FailedAttemptFacts;

  constructor(
    status: number,
    errorType: string,
    code: string | null,
    param: string | null,
    message: string,
    nativeReason: string | null = null,
    attempt: FailedAttemptFacts = emptyAttemptFacts(),
  ) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.errorType = errorType;
    this.code = code;
    this.param = param;
    this.nativeReason = nativeReason;
    this.attempt = attempt;
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
): ProxyError {
  return new ProxyError(status, errorType, code, param, message, nativeReason, attempt ?? emptyAttemptFacts());
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
    return proxyError(504, 'server_error', 'timeout', null, 'The upstream model request timed out.', 'timeout');
  }
  if (error instanceof APIError && error.status === 429) {
    return proxyError(429, 'rate_limit_error', 'rate_limit', null, 'The upstream model request failed.');
  }
  if (error instanceof ProxyError) return error;
  return proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.');
}

export function safeErrorCode(code: string | null): string {
  if (code !== null && /^[a-z0-9_]{1,64}$/.test(code)) return code;
  return 'upstream_error';
}
