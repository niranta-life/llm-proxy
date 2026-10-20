import { APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';

export type OpenAiErrorBody = {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: string | null;
  };
};

export class ProxyError extends Error {
  readonly status: number;
  readonly errorType: string;
  readonly param: string | null;
  readonly code: string | null;

  constructor(
    status: number,
    errorType: string,
    code: string | null,
    param: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'ProxyError';
    this.status = status;
    this.errorType = errorType;
    this.code = code;
    this.param = param;
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
): ProxyError {
  return new ProxyError(status, errorType, code, param, message);
}

export function invalidRequest(param: string, code: string, message: string): ProxyError {
  return proxyError(400, 'invalid_request_error', code, param, message);
}

export function normalizeUpstreamError(error: unknown, callerAborted: boolean): ProxyError {
  if (callerAborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.');
  }
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
    return proxyError(504, 'server_error', 'timeout', null, 'The upstream model request timed out.');
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
