import Anthropic, { APIConnectionTimeoutError, APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import { streamAnthropic } from './anthropic-stream.js';
import type { ProviderAdapter, ProviderCall } from './contract.js';
import type { UpstreamStreamItem } from './openai-stream.js';
import type { StreamTimeouts } from './stream.js';
import { deadlineKindOf, isCallerAbort } from './execution-policy.js';
import {
  ProxyError,
  emptyAttemptFacts,
  invalidRequest,
  proxyError,
  readRetryAfter,
  safeNativeReason,
  safeProviderRequestId,
  timeoutProxy,
  transportFor,
  type FailedAttemptFacts,
} from './errors.js';
import type { TokenUsage, UpstreamCompletion } from './adapter.js';
import type { ChatRequest } from './validate.js';

const ANTHROPIC_FIELDS = new Set(['temperature', 'stop', 'max_tokens', 'max_completion_tokens']);

export type AnthropicUsageParts = TokenUsage & {
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

export type AnthropicMessageBody = {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  system?: string;
  temperature?: number;
  stop_sequences?: string[];
  stream: false;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function anthropicOrigin(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '') {
    throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
  }
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

export function toAnthropicMessageBody(
  request: ChatRequest,
  upstreamModel: string,
  defaultMaxOutputTokens: number | null,
): AnthropicMessageBody {
  for (const key of Object.keys(request.optional)) {
    if (!ANTHROPIC_FIELDS.has(key)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported by this model.`);
    }
  }

  const temperature = request.optional.temperature;
  if (typeof temperature === 'number' && temperature > 1) {
    throw invalidRequest('temperature', 'invalid_parameter', 'temperature is outside the supported range.');
  }

  let system: string | undefined;
  const dialog = [...request.messages];
  const systemCount = dialog.filter((message) => message.role === 'system').length;
  if (systemCount > 1) {
    throw invalidRequest('messages', 'unsupported_message', 'Only one leading system message is supported.');
  }
  if (systemCount === 1 && dialog[0]?.role !== 'system') {
    throw invalidRequest('messages', 'unsupported_message', 'A system message is only supported as the first message.');
  }
  if (dialog[0]?.role === 'system') {
    system = dialog[0].content;
    dialog.shift();
  }
  if (dialog.length === 0 || dialog[0]?.role !== 'user') {
    throw invalidRequest('messages', 'unsupported_message', 'The first Anthropic message must be a user message.');
  }
  if (dialog.at(-1)?.role === 'assistant') {
    throw invalidRequest('messages', 'unsupported_message', 'Assistant prefill is not supported.');
  }
  for (let index = 1; index < dialog.length; index += 1) {
    const previous = dialog[index - 1];
    const current = dialog[index];
    if (previous === undefined || current === undefined || previous.role === current.role) {
      throw invalidRequest('messages', 'unsupported_message', 'Anthropic messages must alternate user and assistant.');
    }
  }

  const maxCompletion = request.optional.max_completion_tokens;
  const maxTokens = request.optional.max_tokens;
  if (typeof maxCompletion === 'number' && typeof maxTokens === 'number' && maxCompletion !== maxTokens) {
    throw invalidRequest('max_completion_tokens', 'invalid_parameter', 'max_completion_tokens and max_tokens disagree.');
  }
  const limit = typeof maxCompletion === 'number'
    ? maxCompletion
    : typeof maxTokens === 'number'
      ? maxTokens
      : defaultMaxOutputTokens;
  if (limit === null) {
    throw invalidRequest('max_completion_tokens', 'invalid_parameter', 'An output token limit is required.');
  }

  const stop = request.optional.stop;
  const body: AnthropicMessageBody = {
    model: upstreamModel,
    max_tokens: limit,
    messages: dialog.map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content,
    })),
    stream: false,
  };
  if (system !== undefined) body.system = system;
  if (typeof temperature === 'number') body.temperature = temperature;
  if (typeof stop === 'string') body.stop_sequences = [stop];
  else if (Array.isArray(stop)) body.stop_sequences = stop;
  return body;
}

export function readAnthropicUsage(value: unknown): AnthropicUsageParts {
  const empty: AnthropicUsageParts = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
  };
  if (!isRecord(value)) return empty;
  const uncached = readCount(value.input_tokens);
  const cacheCreation = Object.prototype.hasOwnProperty.call(value, 'cache_creation_input_tokens')
    ? readCount(value.cache_creation_input_tokens)
    : null;
  const cacheRead = Object.prototype.hasOwnProperty.call(value, 'cache_read_input_tokens')
    ? readCount(value.cache_read_input_tokens)
    : null;
  const completion = readCount(value.output_tokens);
  let prompt: number | null = uncached;
  if (uncached !== null && (cacheCreation !== null || cacheRead !== null)) {
    prompt = uncached + (cacheCreation ?? 0) + (cacheRead ?? 0);
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt !== null && completion !== null ? prompt + completion : null,
    uncachedInputTokens: uncached,
    cacheCreationInputTokens: cacheCreation,
    cacheReadInputTokens: cacheRead,
  };
}

function invalidMessage(value: unknown): ProxyError {
  const facts = emptyAttemptFacts();
  let stopReason: string | null = null;
  if (isRecord(value)) {
    const parts = readAnthropicUsage(value.usage);
    facts.providerRequestId = safeProviderRequestId(value.id);
    facts.promptTokens = parts.promptTokens;
    facts.completionTokens = parts.completionTokens;
    facts.totalTokens = parts.totalTokens;
    facts.uncachedInputTokens = parts.uncachedInputTokens;
    facts.cacheCreationInputTokens = parts.cacheCreationInputTokens;
    facts.cacheReadInputTokens = parts.cacheReadInputTokens;
    if (typeof value.stop_reason === 'string') stopReason = safeNativeReason(value.stop_reason);
  }
  return proxyError(
    502,
    'server_error',
    'invalid_upstream_response',
    null,
    'The upstream model response was invalid.',
    stopReason,
    facts,
  );
}

export function mapAnthropicFinishReason(stopReason: string): 'stop' | 'length' | 'content_filter' {
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return 'stop';
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') return 'length';
  if (stopReason === 'refusal') return 'content_filter';
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

function blockText(block: Record<string, unknown>): string {
  if (block.type === 'text' && typeof block.text === 'string') return block.text;
  if (block.type === 'refusal') {
    if (typeof block.text === 'string') return block.text;
    if (typeof block.refusal === 'string') return block.refusal;
  }
  throw proxyError(502, 'server_error', 'invalid_upstream_response', null, 'The upstream model response was invalid.');
}

export function normalizeAnthropicMessage(value: unknown, createdSeconds: number): UpstreamCompletion {
  if (!isRecord(value) || value.type !== 'message' || value.role !== 'assistant') {
    throw invalidMessage(value);
  }
  const id = safeProviderRequestId(value.id);
  if (id === null || typeof value.model !== 'string' || value.model.length === 0 || value.model.length > 256) {
    throw invalidMessage(value);
  }
  if (typeof value.stop_reason !== 'string') {
    throw invalidMessage(value);
  }
  let finishReason: 'stop' | 'length' | 'content_filter';
  try {
    finishReason = mapAnthropicFinishReason(value.stop_reason);
  } catch {
    throw invalidMessage(value);
  }
  if (!Array.isArray(value.content)) {
    throw invalidMessage(value);
  }
  let content = '';
  for (const block of value.content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      throw invalidMessage(value);
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    let text: string;
    try {
      text = blockText(block);
    } catch {
      throw invalidMessage(value);
    }
    content += text;
  }
  const parts = readAnthropicUsage(value.usage);
  const publicUsage: Record<string, number> = {};
  if (parts.promptTokens !== null) publicUsage.prompt_tokens = parts.promptTokens;
  if (parts.completionTokens !== null) publicUsage.completion_tokens = parts.completionTokens;
  if (parts.totalTokens !== null) publicUsage.total_tokens = parts.totalTokens;
  return {
    response: {
      id,
      object: 'chat.completion',
      created: createdSeconds,
      model: value.model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
      ...(Object.keys(publicUsage).length > 0 ? { usage: publicUsage } : {}),
    },
    usage: {
      promptTokens: parts.promptTokens,
      completionTokens: parts.completionTokens,
      totalTokens: parts.totalTokens,
    },
    providerRequestId: id,
    stopReason: safeNativeReason(value.stop_reason),
    uncachedInputTokens: parts.uncachedInputTokens,
    cacheCreationInputTokens: parts.cacheCreationInputTokens,
    cacheReadInputTokens: parts.cacheReadInputTokens,
  };
}

function anthropicErrorType(error: APIError): string | null {
  const body = error.error;
  if (!isRecord(body)) return null;
  const inner = body.error;
  if (isRecord(inner)) return safeNativeReason(inner.type);
  return safeNativeReason(body.type);
}

export function normalizeAnthropicError(error: unknown, callerAborted: boolean): ProxyError {
  if (callerAborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
  }
  if (error instanceof ProxyError) return error;
  if (error instanceof APIConnectionTimeoutError || error instanceof APIUserAbortError) {
    return timeoutProxy(null);
  }
  if (error instanceof APIError) {
    const native = anthropicErrorType(error);
    const facts: FailedAttemptFacts = {
      ...emptyAttemptFacts(),
      providerRequestId: safeProviderRequestId(error.requestID),
    };
    const transport = transportFor(error, typeof error.status === 'number' ? error.status : null, readRetryAfter(error.headers));
    if (error.status === 401 || error.status === 403) {
      return proxyError(
        401,
        'authentication_error',
        'upstream_auth_error',
        null,
        'The upstream provider rejected the credential.',
        native ?? 'authentication_error',
        facts,
        transport,
      );
    }
    if (error.status === 429) {
      return proxyError(
        429,
        'rate_limit_error',
        'rate_limit',
        null,
        'The upstream model request failed.',
        native ?? 'rate_limit_error',
        facts,
        transport,
      );
    }
    if (error.status === 529) {
      return proxyError(
        529,
        'server_error',
        'overloaded',
        null,
        'The upstream provider is overloaded.',
        native ?? 'overloaded_error',
        facts,
        transport,
      );
    }
    return proxyError(
      502,
      'server_error',
      'upstream_error',
      null,
      'The upstream model request failed.',
      native,
      facts,
      transport,
    );
  }
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

const silentLog = {
  error(): void {},
  warn(): void {},
  info(): void {},
  debug(): void {},
};

export async function executeAnthropic(call: ProviderCall): Promise<UpstreamCompletion> {
  const body = toAnthropicMessageBody(
    call.request,
    call.route.upstreamModel,
    call.route.defaultMaxOutputTokens,
  );
  const client = new Anthropic({
    apiKey: call.apiKey,
    baseURL: anthropicOrigin(call.baseURL),
    maxRetries: 0,
    timeout: call.route.timeoutMs,
    logLevel: 'off',
    logger: silentLog,
    fetch: call.fetchImpl,
    defaultHeaders: call.route.workspaceId
      ? { 'anthropic-workspace-id': call.route.workspaceId }
      : undefined,
  });
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(call.signal.reason);
  };
  if (call.signal.aborted) abort();
  else call.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) controller.abort();
  }, call.route.timeoutMs);
  try {
    const response = await client.messages.create(body, {
      maxRetries: 0,
      timeout: call.route.timeoutMs,
      signal: controller.signal,
    });
    return normalizeAnthropicMessage(response, Math.floor(Date.now() / 1000));
  } catch (error) {
    if (isCallerAbort(call.signal)) throw normalizeAnthropicError(error, true);
    if (error instanceof ProxyError) throw error;
    const kind = deadlineKindOf(call.signal);
    if (kind !== null || controller.signal.aborted) throw timeoutProxy(kind ?? 'attempt');
    throw normalizeAnthropicError(error, false);
  } finally {
    clearTimeout(timer);
    call.signal.removeEventListener('abort', abort);
  }
}

export const anthropicAdapter: ProviderAdapter & {
  stream(call: ProviderCall & { timeouts: StreamTimeouts; deadline: AbortController }): AsyncGenerator<UpstreamStreamItem>;
} = {
  provider: 'anthropic',
  prepare(request, route): void {
    if (route.endpoint === null || route.endpoint.trim() === '') {
      throw proxyError(503, 'server_error', 'service_unavailable', null, 'The service is unavailable.');
    }
    toAnthropicMessageBody(request, route.upstreamModel, route.defaultMaxOutputTokens);
  },
  execute: executeAnthropic,
  stream(call) {
    return streamAnthropic(call);
  },
};
