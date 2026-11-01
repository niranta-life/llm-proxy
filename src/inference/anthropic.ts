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
import {
  messageText,
  requestUsesTools,
  type ChatMessage,
  type ChatRequest,
  type FunctionTool,
  type FunctionToolCall,
  type ToolChoice,
} from './validate.js';

const ANTHROPIC_FIELDS = new Set([
  'temperature',
  'stop',
  'max_tokens',
  'max_completion_tokens',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
]);
const CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FUNCTION_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TOOL_CALLS = 16;

export type AnthropicUsageParts = TokenUsage & {
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
};

export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

export type AnthropicMessageBody = {
  model: string;
  max_tokens: number;
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] }>;
  system?: string;
  temperature?: number;
  stop_sequences?: string[];
  stream: false;
  tools?: Array<{ name: string; description?: string; input_schema: { type: 'object'; [key: string]: unknown } }>;
  tool_choice?: AnthropicToolChoice;
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

function assertAnthropicSchema(schema: Record<string, unknown>, param: string): void {
  if (schema.type === 'null') {
    throw invalidRequest(param, 'unsupported_parameter', 'The schema type is not supported.');
  }
  const properties = schema.properties;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isRecord(child)) assertAnthropicSchema(child, `${param}.${name}`);
    }
  }
  if (isRecord(schema.items)) assertAnthropicSchema(schema.items, `${param}.items`);
}

function copySchema(schema: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

function argumentsObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidRequest('messages', 'invalid_parameter', 'Tool call arguments must be a JSON object.');
  }
  if (!isRecord(parsed)) {
    throw invalidRequest('messages', 'invalid_parameter', 'Tool call arguments must be a JSON object.');
  }
  return parsed;
}

function anthropicDialog(dialog: ChatMessage[]): AnthropicMessageBody['messages'] {
  const messages: AnthropicMessageBody['messages'] = [];
  let pending: AnthropicContentBlock[] = [];
  const flushPending = (text?: string): void => {
    if (pending.length === 0 && text === undefined) return;
    const blocks = pending;
    pending = [];
    if (text !== undefined && text.length > 0) blocks.push({ type: 'text', text });
    messages.push({ role: 'user', content: blocks });
  };
  for (const message of dialog) {
    if (message.role === 'tool') {
      pending.push({
        type: 'tool_result',
        tool_use_id: message.tool_call_id ?? '',
        content: messageText(message),
      });
      continue;
    }
    if (message.role === 'user') {
      if (pending.length > 0) flushPending(messageText(message));
      else messages.push({ role: 'user', content: messageText(message) });
      continue;
    }
    if (pending.length > 0) flushPending();
    if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
      const blocks: AnthropicContentBlock[] = [];
      const text = messageText(message);
      if (text.length > 0) blocks.push({ type: 'text', text });
      for (const call of message.tool_calls) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: argumentsObject(call.function.arguments),
        });
      }
      messages.push({ role: 'assistant', content: blocks });
      continue;
    }
    messages.push({ role: 'assistant', content: messageText(message) });
  }
  if (pending.length > 0) flushPending();
  for (let index = 1; index < messages.length; index += 1) {
    const previous = messages[index - 1];
    const current = messages[index];
    if (previous === undefined || current === undefined || previous.role === current.role) {
      throw invalidRequest('messages', 'unsupported_message', 'Anthropic messages must alternate user and assistant.');
    }
  }
  return messages;
}

function anthropicToolChoice(choice: ToolChoice | undefined, disableParallel: boolean): AnthropicToolChoice | undefined {
  if (choice === undefined && !disableParallel) return undefined;
  if (choice === 'none') return { type: 'none' };
  const disable = disableParallel ? { disable_parallel_tool_use: true as const } : {};
  if (choice === 'required') return { type: 'any', ...disable };
  if (choice !== undefined && typeof choice === 'object') {
    return { type: 'tool', name: choice.function.name, ...disable };
  }
  return { type: 'auto', ...disable };
}

function applyAnthropicTools(body: AnthropicMessageBody, request: ChatRequest): void {
  const tools = request.optional.tools;
  if (Array.isArray(tools)) {
    body.tools = (tools as FunctionTool[]).map((tool, index) => {
      const parameters = tool.function.parameters ?? { type: 'object' };
      const param = `tools[${index}].function.parameters`;
      assertAnthropicSchema(parameters, param);
      const copied = copySchema(parameters);
      if (copied.type !== 'object') {
        throw invalidRequest(param, 'unsupported_parameter', 'Function parameters must be an object schema.');
      }
      const converted: { name: string; description?: string; input_schema: { type: 'object'; [key: string]: unknown } } = {
        name: tool.function.name,
        input_schema: copied as { type: 'object'; [key: string]: unknown },
      };
      if (tool.function.description !== undefined) converted.description = tool.function.description;
      return converted;
    });
  }
  const choice = anthropicToolChoice(
    request.optional.tool_choice as ToolChoice | undefined,
    request.optional.parallel_tool_calls === false,
  );
  if (choice !== undefined) body.tool_choice = choice;
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
    system = messageText(dialog[0]);
    dialog.shift();
  }
  if (dialog.length === 0 || dialog[0]?.role !== 'user') {
    throw invalidRequest('messages', 'unsupported_message', 'The first Anthropic message must be a user message.');
  }
  if (dialog.at(-1)?.role === 'assistant') {
    throw invalidRequest('messages', 'unsupported_message', 'Assistant prefill is not supported.');
  }
  const usesTools = requestUsesTools(request);
  if (!usesTools) {
    for (let index = 1; index < dialog.length; index += 1) {
      const previous = dialog[index - 1];
      const current = dialog[index];
      if (previous === undefined || current === undefined || previous.role === current.role) {
        throw invalidRequest('messages', 'unsupported_message', 'Anthropic messages must alternate user and assistant.');
      }
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
    messages: usesTools
      ? anthropicDialog(dialog)
      : dialog.map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: messageText(message),
        })),
    stream: false,
  };
  if (system !== undefined) body.system = system;
  // This model rejects temperature. Omit it instead of forwarding a provider 400.
  if (typeof temperature === 'number' && upstreamModel !== 'claude-sonnet-5-5') {
    body.temperature = temperature;
  }
  if (typeof stop === 'string') body.stop_sequences = [stop];
  else if (Array.isArray(stop)) body.stop_sequences = stop;
  if (usesTools) applyAnthropicTools(body, request);
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

function readAnthropicToolUse(block: Record<string, unknown>, source: unknown, seen: Set<string>): FunctionToolCall {
  const id = block.id;
  const name = block.name;
  const input = block.input;
  if (typeof id !== 'string' || !CALL_ID.test(id) || seen.has(id)) throw invalidMessage(source);
  seen.add(id);
  if (typeof name !== 'string' || !FUNCTION_NAME.test(name)) throw invalidMessage(source);
  if (!isRecord(input)) throw invalidMessage(source);
  const encoded = JSON.stringify(input);
  if (encoded.length === 0 || encoded.length > 8192) throw invalidMessage(source);
  return { id, type: 'function', function: { name, arguments: encoded } };
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
  if (!Array.isArray(value.content)) {
    throw invalidMessage(value);
  }
  const toolCalls: FunctionToolCall[] = [];
  const seen = new Set<string>();
  let content = '';
  for (const block of value.content) {
    if (!isRecord(block) || typeof block.type !== 'string') {
      throw invalidMessage(value);
    }
    if (block.type === 'thinking' || block.type === 'redacted_thinking') continue;
    if (block.type === 'tool_use') {
      if (toolCalls.length >= MAX_TOOL_CALLS) throw invalidMessage(value);
      toolCalls.push(readAnthropicToolUse(block, value, seen));
      continue;
    }
    let text: string;
    try {
      text = blockText(block);
    } catch {
      throw invalidMessage(value);
    }
    content += text;
  }
  if (toolCalls.length > 0 && value.stop_reason !== 'tool_use') throw invalidMessage(value);
  if (toolCalls.length === 0 && value.stop_reason === 'tool_use') throw invalidMessage(value);
  let finishReason: 'stop' | 'length' | 'content_filter' | 'tool_calls';
  if (toolCalls.length > 0) {
    finishReason = 'tool_calls';
  } else {
    try {
      finishReason = mapAnthropicFinishReason(value.stop_reason);
    } catch {
      throw invalidMessage(value);
    }
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
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls.length > 0 && content.length === 0 ? null : content,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
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
