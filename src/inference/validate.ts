import { ProxyError, invalidRequest } from './errors.js';

const UNSUPPORTED = new Set([
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'parallel_tool_calls',
  'modalities',
  'audio',
  'reasoning_effort',
  'logprobs',
  'top_logprobs',
  'logit_bias',
  'store',
  'metadata',
  'service_tier',
  'prediction',
  'web_search_options',
]);

const OPTIONAL = new Set([
  'temperature',
  'top_p',
  'max_tokens',
  'max_completion_tokens',
  'stop',
  'presence_penalty',
  'frequency_penalty',
  'seed',
  'n',
  'user',
  'response_format',
]);

const ROLES = new Set(['system', 'user', 'assistant']);

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  includeUsage: boolean;
  optional: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberInRange(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}

export function validateChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) {
    throw invalidRequest('body', 'invalid_request', 'The request body must be a JSON object.');
  }

  let stream = false;
  if ('stream' in body) {
    if (body.stream === true) stream = true;
    else if (body.stream !== false) {
      throw invalidRequest('stream', 'invalid_parameter', 'stream must be false when it is set.');
    }
  }
  const includeUsage = parseStreamOptions(body, stream);

  for (const key of Object.keys(body)) {
    if (key === 'model' || key === 'messages' || key === 'stream' || key === 'stream_options') continue;
    if (UNSUPPORTED.has(key)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported.`);
    }
    if (!OPTIONAL.has(key)) {
      throw invalidRequest(key, 'unknown_parameter', `${key} is not a supported parameter.`);
    }
  }

  if (typeof body.model !== 'string' || body.model.trim() === '' || body.model.length > 128 || /\s/.test(body.model)) {
    throw invalidRequest('model', 'invalid_parameter', 'model must be a non-empty string without spaces.');
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 100) {
    throw invalidRequest('messages', 'invalid_parameter', 'messages must contain from 1 to 100 items.');
  }

  const messages = body.messages.map((message, index) => parseMessage(message, index));
  const optional: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (!OPTIONAL.has(key)) continue;
    optional[key] = parseOptional(key, body[key]);
  }

  return { model: body.model, messages, stream, includeUsage, optional };
}

function parseStreamOptions(body: Record<string, unknown>, stream: boolean): boolean {
  if (!('stream_options' in body)) return false;
  if (!stream) {
    throw invalidRequest('stream_options', 'unsupported_parameter', 'stream_options is not supported.');
  }
  const value = body.stream_options;
  if (!isRecord(value)) {
    throw invalidRequest('stream_options', 'invalid_parameter', 'stream_options must be an object.');
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== 'include_usage')) {
    throw invalidRequest('stream_options', 'unsupported_parameter', 'stream_options is not supported.');
  }
  if (value.include_usage === undefined) return false;
  if (typeof value.include_usage !== 'boolean') {
    throw invalidRequest('stream_options.include_usage', 'invalid_parameter', 'include_usage must be a boolean.');
  }
  return value.include_usage;
}

export function assertStreamAllowed(
  request: ChatRequest,
  route: { provider: string; streamingEnabled: boolean },
  tenantStreamingEnabled: boolean,
): void {
  if (!request.stream) return;
  if (
    (route.provider === 'openai' ||
      route.provider === 'anthropic' ||
      route.provider === 'vertex' ||
      route.provider === 'xai' ||
      route.provider === 'openrouter' ||
      route.provider === 'dgx') &&
    tenantStreamingEnabled &&
    route.streamingEnabled
  ) {
    return;
  }
  throw invalidRequest('stream', 'unsupported_parameter', 'Streaming is not supported.');
}

function parseMessage(value: unknown, index: number): ChatMessage {
  const param = `messages[${index}]`;
  if (!isRecord(value)) {
    throw invalidRequest(param, 'invalid_parameter', 'Each message must be an object.');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'role' && key !== 'content') {
      throw invalidRequest(`${param}.${key}`, 'unknown_parameter', `${key} is not a supported message field.`);
    }
  }
  if (typeof value.role !== 'string' || !ROLES.has(value.role)) {
    throw invalidRequest(`${param}.role`, 'unsupported_message', 'Only system, user, and assistant text messages are supported.');
  }
  if (Array.isArray(value.content)) {
    const multimodal = value.content.some(
      (part) =>
        isRecord(part) &&
        (part.type === 'image_url' || part.type === 'image' || part.type === 'audio' || part.type === 'input_audio'),
    );
    throw invalidRequest(
      `${param}.content`,
      multimodal ? 'unsupported_modality' : 'unsupported_message',
      'Only text message content is supported.',
    );
  }
  if (typeof value.content !== 'string' || value.content.length === 0 || value.content.length > 100_000) {
    throw invalidRequest(`${param}.content`, 'invalid_parameter', 'Message content must be text.');
  }
  return { role: value.role as ChatMessage['role'], content: value.content };
}

function parseOptional(key: string, value: unknown): unknown {
  if (key === 'temperature' || key === 'top_p' || key === 'presence_penalty' || key === 'frequency_penalty') {
    const max = key === 'top_p' ? 1 : key === 'temperature' ? 2 : 2;
    const min = key === 'temperature' || key === 'top_p' ? 0 : -2;
    const parsed = numberInRange(value, min, max);
    if (parsed === undefined) {
      throw invalidRequest(key, 'invalid_parameter', `${key} is outside the supported range.`);
    }
    return parsed;
  }
  if (key === 'max_tokens' || key === 'max_completion_tokens') {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 128_000) {
      throw invalidRequest(key, 'invalid_parameter', `${key} must be an integer from 1 to 128000.`);
    }
    return value;
  }
  if (key === 'seed') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw invalidRequest(key, 'invalid_parameter', 'seed must be an integer.');
    }
    return value;
  }
  if (key === 'n') {
    if (value !== 1) throw invalidRequest('n', 'unsupported_parameter', 'Only one completion is supported.');
    return 1;
  }
  if (key === 'user') {
    if (typeof value !== 'string' || value.length < 1 || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
      throw invalidRequest('user', 'invalid_parameter', 'user must be a short text string.');
    }
    return value;
  }
  if (key === 'stop') return parseStop(value);
  if (key === 'response_format') return parseResponseFormat(value);
  throw invalidRequest(key, 'unknown_parameter', `${key} is not a supported parameter.`);
}

function parseStop(value: unknown): string | string[] {
  if (typeof value === 'string' && value.length > 0 && value.length <= 256) return value;
  if (Array.isArray(value) && value.length > 0 && value.length <= 4 && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 256)) {
    return value;
  }
  throw invalidRequest('stop', 'invalid_parameter', 'stop must be a string or up to four strings.');
}

function parseResponseFormat(value: unknown): { type: 'text' } {
  if (!isRecord(value)) {
    throw invalidRequest('response_format', 'unsupported_response_format', 'response_format is not supported.');
  }
  const extra = Object.keys(value).filter((key) => key !== 'type');
  if (extra.length > 0) {
    throw invalidRequest('response_format', 'unsupported_response_format', 'Only text response_format is supported.');
  }
  if (value.type !== 'text') {
    throw invalidRequest('response_format', 'unsupported_response_format', 'Only text response_format is supported.');
  }
  return { type: 'text' };
}

export function assertCapabilities(request: ChatRequest, capabilities: readonly string[]): void {
  for (const key of Object.keys(request.optional)) {
    const capability = key === 'response_format' ? 'response_format_text' : key;
    if (!capabilities.includes(capability)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported by this model.`);
    }
  }
}

export function isProxyError(error: unknown): error is ProxyError {
  return error instanceof ProxyError;
}
