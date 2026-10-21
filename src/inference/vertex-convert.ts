import { ApiError } from '@google/genai';
import type { UpstreamCompletion } from './adapter.js';
import {
  emptyAttemptFacts,
  invalidRequest,
  proxyError,
  safeProviderRequestId,
  transportFor,
  type FailedAttemptFacts,
} from './errors.js';
import type { CanonicalEvent } from './stream.js';
import type { ChatRequest } from './validate.js';

const VERTEX_FIELDS = new Set(['temperature', 'stop', 'max_tokens', 'max_completion_tokens']);
const SAFETY_REASONS = new Set(['SAFETY', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'RECITATION']);
const PART_FIELDS = [
  'inlineData',
  'fileData',
  'functionCall',
  'functionResponse',
  'executableCode',
  'codeExecutionResult',
  'toolCall',
  'toolResponse',
  'audioTranscription',
  'videoMetadata',
] as const;

export type VertexContent = {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
};

export type VertexUsageParts = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  uncachedInputTokens: number | null;
  cacheCreationInputTokens: null;
  cacheReadInputTokens: number | null;
  thoughtsTokens: number | null;
};

export type VertexRequestBody = {
  model: string;
  contents: VertexContent[];
  config: {
    systemInstruction?: string;
    maxOutputTokens?: number;
    temperature?: number;
    stopSequences?: string[];
    automaticContinuation: false;
  };
};

export type VertexStreamCursor = {
  started: boolean;
  finished: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function readVertexUsage(value: unknown): VertexUsageParts {
  const empty: VertexUsageParts = {
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    uncachedInputTokens: null,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: null,
    thoughtsTokens: null,
  };
  if (!isRecord(value)) return empty;
  const prompt = readCount(value.promptTokenCount);
  const completion = readCount(value.candidatesTokenCount);
  const cachedPresent = hasOwn(value, 'cachedContentTokenCount');
  const cached = cachedPresent ? readCount(value.cachedContentTokenCount) : null;
  const thoughtsPresent = hasOwn(value, 'thoughtsTokenCount');
  const thoughts = thoughtsPresent ? readCount(value.thoughtsTokenCount) : null;
  const totalPresent = hasOwn(value, 'totalTokenCount');
  const totalGiven = totalPresent ? readCount(value.totalTokenCount) : null;
  let uncached: number | null = null;
  if (cachedPresent && cached !== null && prompt !== null && prompt >= cached) {
    uncached = prompt - cached;
  } else if (!cachedPresent && prompt !== null) {
    uncached = prompt;
  }
  let total = totalGiven;
  const thinking = thoughts !== null && thoughts > 0;
  if (total === null && !thinking && prompt !== null && completion !== null) {
    total = prompt + completion;
  }
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    uncachedInputTokens: uncached,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: cached,
    thoughtsTokens: thoughts,
  };
}

function usageFacts(value: unknown): FailedAttemptFacts {
  const facts = emptyAttemptFacts();
  if (!isRecord(value)) return facts;
  const usage = readVertexUsage(value.usageMetadata);
  facts.providerRequestId = safeProviderRequestId(value.responseId);
  facts.promptTokens = usage.promptTokens;
  facts.completionTokens = usage.completionTokens;
  facts.totalTokens = usage.totalTokens;
  facts.uncachedInputTokens = usage.uncachedInputTokens;
  facts.cacheReadInputTokens = usage.cacheReadInputTokens;
  facts.thoughtsTokens = usage.thoughtsTokens;
  return facts;
}

function invalidVertex(value: unknown): never {
  throw proxyError(
    502,
    'server_error',
    'invalid_upstream_response',
    null,
    'The upstream model response was invalid.',
    null,
    usageFacts(value),
  );
}

export function toVertexRequest(request: ChatRequest, upstreamModel: string): VertexRequestBody {
  for (const key of Object.keys(request.optional)) {
    if (!VERTEX_FIELDS.has(key)) {
      throw invalidRequest(key, 'unsupported_parameter', `${key} is not supported by this model.`);
    }
  }
  const temperature = request.optional.temperature;
  if (typeof temperature === 'number' && (temperature < 0 || temperature > 2)) {
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
  if (dialog.length === 0) {
    throw invalidRequest('messages', 'unsupported_message', 'A user or assistant message is required.');
  }
  const maxCompletion = request.optional.max_completion_tokens;
  const maxTokens = request.optional.max_tokens;
  if (typeof maxCompletion === 'number' && typeof maxTokens === 'number' && maxCompletion !== maxTokens) {
    throw invalidRequest('max_completion_tokens', 'invalid_parameter', 'max_completion_tokens and max_tokens disagree.');
  }
  const limit = typeof maxCompletion === 'number' ? maxCompletion : typeof maxTokens === 'number' ? maxTokens : undefined;
  const stop = request.optional.stop;
  let stopSequences: string[] | undefined;
  if (typeof stop === 'string') stopSequences = [stop];
  else if (Array.isArray(stop)) stopSequences = stop;
  if (stopSequences !== undefined && stopSequences.length > 5) {
    throw invalidRequest('stop', 'invalid_parameter', 'stop must be a string or up to five strings.');
  }
  const body: VertexRequestBody = {
    model: upstreamModel,
    contents: dialog.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
    config: { automaticContinuation: false },
  };
  if (system !== undefined) body.config.systemInstruction = system;
  if (limit !== undefined) body.config.maxOutputTokens = limit;
  if (typeof temperature === 'number') body.config.temperature = temperature;
  if (stopSequences !== undefined) body.config.stopSequences = stopSequences;
  return body;
}

export function blockNative(reason: string): string {
  const native = reason.toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/.test(native)) invalidVertex(null);
  return native;
}

export function mapVertexFinish(reason: string): { finish: 'stop' | 'length' | 'content_filter'; native: string } {
  const native = reason.toLowerCase();
  if (!/^[a-z0-9_]{1,64}$/.test(native)) invalidVertex(null);
  if (reason === 'STOP') return { finish: 'stop', native };
  if (reason === 'MAX_TOKENS') return { finish: 'length', native };
  if (SAFETY_REASONS.has(reason)) return { finish: 'content_filter', native };
  throw proxyError(
    502,
    'server_error',
    'invalid_upstream_response',
    null,
    'The upstream model response was invalid.',
    null,
  );
}

function visibleText(parts: unknown, source: unknown): string {
  if (!Array.isArray(parts)) invalidVertex(source);
  let text = '';
  for (const part of parts) {
    if (!isRecord(part)) invalidVertex(source);
    if (PART_FIELDS.some((field) => part[field] !== undefined)) invalidVertex(source);
    if (part.thought === true) continue;
    if (part.text === undefined) {
      const keys = Object.keys(part).filter((key) => key !== 'thoughtSignature' && key !== 'partMetadata');
      if (keys.length > 0) invalidVertex(source);
      continue;
    }
    if (typeof part.text !== 'string') invalidVertex(source);
    text += part.text;
  }
  return text;
}

function publicUsage(usage: VertexUsageParts): Record<string, number> {
  const body: Record<string, number> = {};
  if (usage.promptTokens !== null) body.prompt_tokens = usage.promptTokens;
  if (usage.completionTokens !== null) body.completion_tokens = usage.completionTokens;
  if (usage.totalTokens !== null) body.total_tokens = usage.totalTokens;
  return body;
}

export function normalizeVertexResponse(
  value: unknown,
  createdSeconds: number,
  upstreamModel: string,
): UpstreamCompletion {
  if (!isRecord(value)) invalidVertex(value);
  const usage = readVertexUsage(value.usageMetadata);
  const providerRequestId = safeProviderRequestId(value.responseId);
  const model = typeof value.modelVersion === 'string' && value.modelVersion.length > 0 && value.modelVersion.length <= 256
    ? value.modelVersion
    : upstreamModel;
  const blocked = isRecord(value.promptFeedback) && typeof value.promptFeedback.blockReason === 'string';
  const candidates = value.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    if (!blocked) invalidVertex(value);
    const native = blockNative(String((value.promptFeedback as { blockReason: string }).blockReason));
    const shown = publicUsage(usage);
    return {
      response: {
        id: providerRequestId ?? 'chatcmpl-vertex',
        object: 'chat.completion',
        created: createdSeconds,
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'content_filter' }],
        ...(Object.keys(shown).length > 0 ? { usage: shown } : {}),
      },
      usage: {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
      },
      providerRequestId,
      stopReason: native,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      thoughtsTokens: usage.thoughtsTokens,
    };
  }
  if (candidates.length !== 1 || !isRecord(candidates[0])) invalidVertex(value);
  const candidate = candidates[0];
  if (typeof candidate.finishReason !== 'string') invalidVertex(value);
  let mapped: { finish: 'stop' | 'length' | 'content_filter'; native: string };
  try {
    mapped = mapVertexFinish(candidate.finishReason);
  } catch (error) {
    if (error instanceof Error && error.name === 'ProxyError') {
      throw proxyError(
        502,
        'server_error',
        'invalid_upstream_response',
        null,
        'The upstream model response was invalid.',
        null,
        usageFacts(value),
      );
    }
    throw error;
  }
  const contentRecord = candidate.content;
  const parts = isRecord(contentRecord) ? contentRecord.parts : [];
  let content = '';
  try {
    content = visibleText(parts ?? [], value);
  } catch (error) {
    if (error instanceof Error && error.name === 'ProxyError') throw error;
    invalidVertex(value);
  }
  const shown = publicUsage(usage);
  return {
    response: {
      id: providerRequestId ?? 'chatcmpl-vertex',
      object: 'chat.completion',
      created: createdSeconds,
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: mapped.finish }],
      ...(Object.keys(shown).length > 0 ? { usage: shown } : {}),
    },
    usage: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    },
    providerRequestId,
    stopReason: mapped.native,
    uncachedInputTokens: usage.uncachedInputTokens,
    cacheCreationInputTokens: null,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    thoughtsTokens: usage.thoughtsTokens,
  };
}

export function eventsFromVertexChunk(
  chunk: unknown,
  cursor: VertexStreamCursor,
  upstreamModel: string,
  createdSeconds: number,
): { cursor: VertexStreamCursor; events: CanonicalEvent[] } {
  if (!isRecord(chunk)) invalidVertex(chunk);
  const events: CanonicalEvent[] = [];
  const next = { ...cursor };
  const providerRequestId = safeProviderRequestId(chunk.responseId);
  const model = typeof chunk.modelVersion === 'string' && chunk.modelVersion.length > 0 && chunk.modelVersion.length <= 256
    ? chunk.modelVersion
    : upstreamModel;
  if (!next.started) {
    events.push({
      type: 'start',
      id: providerRequestId ?? 'chatcmpl-vertex',
      model,
      created: createdSeconds,
      providerRequestId,
    });
    next.started = true;
  }
  const blocked = isRecord(chunk.promptFeedback) && typeof chunk.promptFeedback.blockReason === 'string';
  const candidates = chunk.candidates;
  if (Array.isArray(candidates) && candidates.length > 1) invalidVertex(chunk);
  const candidate = Array.isArray(candidates) && isRecord(candidates[0]) ? candidates[0] : null;
  if (candidate !== null) {
    const contentRecord = candidate.content;
    if (isRecord(contentRecord) && contentRecord.parts !== undefined) {
      const text = visibleText(contentRecord.parts, chunk);
      if (text.length > 0) events.push({ type: 'text_delta', text });
    }
    if (typeof candidate.finishReason === 'string' && !next.finished) {
      const mapped = mapVertexFinish(candidate.finishReason);
      events.push({ type: 'finish', finishReason: mapped.finish, nativeReason: mapped.native });
      next.finished = true;
    }
  } else if (blocked && !next.finished) {
    const native = blockNative(String((chunk.promptFeedback as { blockReason: string }).blockReason));
    events.push({ type: 'finish', finishReason: 'content_filter', nativeReason: native });
    next.finished = true;
  }
  if (chunk.usageMetadata !== undefined) {
    const usage = readVertexUsage(chunk.usageMetadata);
    events.push({
      type: 'usage',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      uncachedInputTokens: usage.uncachedInputTokens,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      thoughtsTokens: usage.thoughtsTokens,
    });
  }
  return { cursor: next, events };
}

function statusOf(error: unknown): number | null {
  if (error instanceof ApiError) return error.status;
  if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
    return error.status;
  }
  return null;
}

export function normalizeVertexError(error: unknown, callerAborted: boolean, retryAfter: string | null = null): Error {
  if (callerAborted) {
    return proxyError(408, 'server_error', 'request_cancelled', null, 'The request was cancelled.', 'request_cancelled');
  }
  if (error instanceof Error && error.name === 'ProxyError') return error;
  const status = statusOf(error);
  const transport = transportFor(error, status, retryAfter);
  if (status === 401) {
    return proxyError(401, 'authentication_error', 'expired_credentials', null, 'The upstream provider rejected the credential.', 'expired_credentials', undefined, transport);
  }
  if (status === 403) {
    return proxyError(403, 'permission_error', 'permission_denied', null, 'The upstream provider denied the request.', 'permission_denied', undefined, transport);
  }
  if (status === 404) {
    return proxyError(404, 'invalid_request_error', 'model_not_available', 'model', 'The model is not available.', 'model_not_available', undefined, transport);
  }
  if (status === 400) {
    return proxyError(400, 'invalid_request_error', 'invalid_project', null, 'The Google Cloud project or location is not valid.', 'invalid_project', undefined, transport);
  }
  return proxyError(502, 'server_error', 'upstream_error', null, 'The upstream model request failed.', null, undefined, transport);
}
